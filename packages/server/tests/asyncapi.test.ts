import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '@chanx-js/codegen';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AsyncAPIDocument } from '../src';
import type { MessageOf } from '../src';
import {
  AsyncJsonWebsocketConsumer,
  Consumer,
  On,
  PingMessage,
  PongMessage,
  Topic,
  consumer,
  createChanx,
  defineMessage,
  topic,
  topicConsumer,
} from '../src';

// chanx's FastAPI sandbox schema, which the client conformance tests generate from.
const fixture = JSON.parse(
  await readFile(
    fileURLToPath(
      new URL('../../codegen/tests/__fixtures__/fastapi-asyncapi.json', import.meta.url),
    ),
    'utf8',
  ),
) as AsyncAPIDocument;

// The sandbox's topic hub, its two topics and the standalone RoomTopic route, rebuilt in
// Node with the Python classes' names and docstrings.
const PostPayload = z
  .object({ body: z.string(), author: z.string().default('anonymous') })
  .meta({ title: 'PostPayload' });
const PresencePayload = z
  .object({ user: z.string(), online: z.boolean() })
  .meta({ title: 'PresencePayload' });
const Post = defineMessage('post', PostPayload, {
  description: 'Post something to a room.',
});
const Echo = defineMessage('echo', PostPayload, {
  description: 'Ask for an acknowledgement without broadcasting.',
});
const Posted = defineMessage('posted', PostPayload, { description: 'Confirm a post.' });
const RoomEvent = defineMessage('room_event', PostPayload, {
  title: 'RoomEvent',
  description: 'Something happened in a room.',
});
const PresenceChanged = defineMessage('presence_changed', PresencePayload, {
  title: 'PresenceChanged',
  description: "A user's presence changed.",
});

const roomTopic = topic('room:{room_name}', {
  description: 'A chat room, addressed as room:<room_name>.',
})
  .on(Post, { summary: 'Post to a room' }, () => {})
  .on(Echo, { output: Posted, summary: 'Acknowledge without broadcasting' }, (m) =>
    Posted.create(m.payload),
  )
  .passthrough(RoomEvent);
const presenceTopic = topic('presence:{user}', {
  description: 'Presence for one user, addressed as presence:<user>.',
}).passthrough(PresenceChanged);
const hub = consumer('/ws/topics', {
  name: 'topic_hub',
  description: 'Several topics multiplexed over a single connection',
  tags: ['topics'],
  topics: [roomTopic, presenceTopic],
}).on(PingMessage, { output: PongMessage, summary: 'Handle ping requests' }, () =>
  PongMessage.create(),
);

const node = createChanx({
  consumers: [hub, roomTopic.asConsumer('/ws/topics/room/{room_name}')],
}).asyncapi({
  title: 'FastAPI AsyncAPI documentation',
  serverUrl: 'testserver',
});

// The same topics as chanx's sandbox writes them, as classes.
class RoomTopic extends Topic {
  static override pattern = 'room:{room_name}';
  static override description = 'A chat room, addressed as room:<room_name>.';
  static override passthrough = [RoomEvent];

  @On(Echo, { output: Posted, summary: 'Acknowledge without broadcasting' })
  handle_echo(m: MessageOf<typeof Echo>) {
    return Posted.create(m.payload);
  }

  @On(Post, { summary: 'Post to a room' })
  handle_post() {}
}
class PresenceTopic extends Topic {
  static override pattern = 'presence:{user}';
  static override description = 'Presence for one user, addressed as presence:<user>.';
  static override passthrough = [PresenceChanged];
}
const classes = createChanx({
  consumers: [
    consumer('/ws/topics', {
      name: 'topic_hub',
      description: 'Several topics multiplexed over a single connection',
      tags: ['topics'],
      topics: [RoomTopic, PresenceTopic],
    }).on(PingMessage, { output: PongMessage, summary: 'Handle ping requests' }, () =>
      PongMessage.create(),
    ),
    topicConsumer(RoomTopic, '/ws/topics/room/{room_name}'),
  ],
}).asyncapi({
  title: 'FastAPI AsyncAPI documentation',
  serverUrl: 'testserver',
});

const CHANNELS = [
  'topic_hub',
  'topic_hub_room_topic',
  'topic_hub_presence_topic',
  'room_topic',
];

/** The fixture cut down to these channels, their operations and what they reference. */
function subset(document: AsyncAPIDocument): AsyncAPIDocument {
  const channels = Object.fromEntries(
    CHANNELS.map((name) => [name, document.channels[name]!]),
  );
  const operations = Object.fromEntries(
    Object.entries(document.operations).filter(([, op]) =>
      CHANNELS.some((name) => op.channel.$ref === `#/channels/${name}`),
    ),
  );
  const messages = new Set(
    Object.values(channels).flatMap((channel) => Object.keys(channel.messages)),
  );
  const schemas = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value === null || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (
        key === '$ref' &&
        typeof item === 'string' &&
        item.startsWith('#/components/schemas/')
      ) {
        const name = item.split('/').at(-1)!;
        if (!schemas.has(name)) {
          schemas.add(name);
          walk(document.components.schemas[name]);
        }
      } else walk(item);
    }
  };
  walk([...messages].map((name) => document.components.messages[name]));
  return {
    ...document,
    channels,
    operations,
    components: {
      messages: Object.fromEntries(
        [...messages].sort().map((name) => [name, document.components.messages[name]!]),
      ),
      schemas: Object.fromEntries(
        [...schemas].sort().map((name) => [name, document.components.schemas[name]!]),
      ),
      correlationIds: document.components.correlationIds,
    },
  };
}

const python = subset(fixture);
const operationBodies = (document: AsyncAPIDocument) =>
  Object.values(document.operations)
    .map((op) => JSON.stringify(op))
    .sort();
// pydantic titles every field ("Body"); schema libraries do not. Nothing reads them.
const withoutFieldTitles = (schema: Record<string, unknown>) => ({
  ...schema,
  properties: Object.fromEntries(
    Object.entries(
      (schema.properties ?? {}) as Record<string, Record<string, unknown>>,
    ).map(([name, { title, ...field }]) => [name, (void title, field)]),
  ),
});

describe('AsyncAPI, against chanx', () => {
  it.each(CHANNELS)('documents the %s channel as chanx does', (name) => {
    expect(node.channels[name]).toEqual(python.channels[name]);
  });

  it('documents the same operations, apart from names chanx prefixed for other consumers', () => {
    expect(operationBodies(node)).toEqual(operationBodies(python));
  });

  it('documents the same messages and message schemas', () => {
    expect(node.components.messages).toEqual(python.components.messages);
    expect(node.components.correlationIds).toEqual(python.components.correlationIds);
    for (const name of [
      'PingMessage',
      'PongMessage',
      'PostMessage',
      'EchoMessage',
      'PostedMessage',
      'RoomEvent',
      'PresenceChanged',
    ]) {
      expect(node.components.schemas[name], name).toEqual(
        python.components.schemas[name],
      );
    }
  });

  it('documents payload schemas as chanx does, field titles aside', () => {
    for (const name of ['PostPayload', 'PresencePayload']) {
      expect(withoutFieldTitles(node.components.schemas[name]!), name).toEqual(
        withoutFieldTitles(python.components.schemas[name]!),
      );
    }
  });

  it('generates the same client with @chanx-js/codegen', async () => {
    const dirs = await Promise.all([
      mkdtemp(join(tmpdir(), 'chanx-py-')),
      mkdtemp(join(tmpdir(), 'chanx-node-')),
    ]);
    try {
      await generate(python as never, { outDir: dirs[0]!, format: false });
      await generate(node as never, { outDir: dirs[1]!, format: false });
      for (const file of ['channels.ts', 'schemas.ts', 'index.ts']) {
        const [fromPython, fromNode] = await Promise.all(
          dirs.map((dir) => readFile(join(dir, file), 'utf8')),
        );
        expect(fromNode, file).toBe(fromPython);
      }
    } finally {
      await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });
});

describe('AsyncAPI from Topic classes, against chanx', () => {
  it('documents the same channels, operations and components as the builders', () => {
    expect(classes.channels).toEqual(node.channels);
    expect(operationBodies(classes)).toEqual(operationBodies(python));
    expect(classes.components).toEqual(node.components);
  });

  it("names operations after the methods, as chanx does: these are the sandbox's names", () => {
    const hosted = Object.entries(classes.operations)
      .filter(([, op]) => op.channel.$ref.endsWith('topic_hub_room_topic'))
      .map(([name]) => name);
    expect(hosted).toEqual([
      'handle_echo',
      'handle_post',
      'handle_passthrough_room_event',
    ]);
  });
});

describe('AsyncAPI', () => {
  it("starts with chanx's defaults: Django's and FastAPI's, whose description is empty", () => {
    const { asyncapi, info, servers } = createChanx({ consumers: [] }).asyncapi();
    expect({ asyncapi, info, servers }).toEqual({
      asyncapi: '3.0.0',
      info: { title: 'AsyncAPI Documentation', version: '1.0.0', description: '' },
      servers: { development: { host: 'localhost:8000', protocol: 'ws' } },
    });
  });

  it('puts the metadata it is given into info, untouched by camelize', () => {
    const metadata = {
      termsOfService: 'https://example.com/terms',
      contact: { name: 'API team', email: 'api@example.com' },
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
      tags: [{ name: 'chat', description: 'Chat rooms' }],
      externalDocs: { url: 'https://example.com/docs' },
    };
    for (const camelize of [false, true]) {
      const { info } = createChanx({ consumers: [], camelize }).asyncapi({
        title: 'Chat API',
        ...metadata,
      });
      expect(info).toEqual({
        title: 'Chat API',
        version: '1.0.0',
        description: '',
        ...metadata,
      });
    }
  });

  it('documents what a consumer pushes, so a generated client can receive it', () => {
    const Notice = defineMessage('notice', z.object({ text: z.string() }));
    const document = createChanx({
      consumers: [consumer('/ws', { name: 'news', emits: [Notice] })],
    }).asyncapi();
    expect(document.operations.news_emits).toMatchObject({
      action: 'send',
      messages: [{ $ref: '#/channels/news/messages/notice_message' }],
    });
  });

  it("lists an event's output, not its input, as chanx's chat channel omits SystemNotify", () => {
    const SystemNotify = defineMessage('system_notify', z.string());
    const ChatNotification = defineMessage(
      'chat_notification',
      z.object({ message: z.string() }),
    );
    const document = createChanx({
      consumers: [
        consumer('/ws/chat', { name: 'chat' }).event(
          SystemNotify,
          { output: ChatNotification },
          (e) => ChatNotification.create({ message: e.payload }),
        ),
      ],
    }).asyncapi();

    expect(Object.keys(document.channels.chat!.messages as object)).toEqual([
      'chat_notification_message',
    ]);
    expect(document.operations.handle_system_notify).toMatchObject({
      action: 'send',
      messages: [{ $ref: '#/channels/chat/messages/chat_notification_message' }],
    });
  });

  it('hoists nested schemas into components and inlines untitled ones', () => {
    const Inner = z.object({ id: z.number() }).meta({ id: 'Inner', title: 'Inner' });
    const Outer = defineMessage(
      'outer',
      z.object({ inner: Inner, tags: z.array(z.string()) }),
    );
    const document = createChanx({
      consumers: [consumer('/ws', { name: 'x' }).on(Outer, () => {})],
    }).asyncapi();

    expect(document.components.schemas.Inner).toMatchObject({
      title: 'Inner',
      type: 'object',
    });
    expect(document.components.schemas.OuterMessage!.properties).toMatchObject({
      payload: { properties: { inner: { $ref: '#/components/schemas/Inner' } } },
    });
  });

  it('refuses two different schemas under one title', () => {
    const A = defineMessage('a', z.object({ x: z.string() }).meta({ title: 'Payload' }));
    const B = defineMessage('b', z.object({ y: z.number() }).meta({ title: 'Payload' }));
    const chanx = createChanx({
      consumers: [
        consumer('/ws', { name: 'x' })
          .on(A, () => {})
          .on(B, () => {}),
      ],
    });
    expect(() => chanx.asyncapi()).toThrow('Two different schemas are titled "Payload"');
  });

  it('names a class handler operation after its method, as chanx does', () => {
    @Consumer('/ws', { name: 'classy' })
    class Classy extends AsyncJsonWebsocketConsumer {
      @On(PingMessage, { output: PongMessage })
      handlePing() {
        return PongMessage.create();
      }
    }
    const document = createChanx({ consumers: [Classy] }).asyncapi();
    expect(Object.keys(document.operations)).toEqual(['handle_ping']);
  });

  it("names a builder handler's operation after its `name` option", () => {
    const pinger = consumer('/ws', { name: 'pinger' }).on(
      PingMessage,
      { name: 'keep_alive', output: PongMessage },
      () => PongMessage.create(),
    );
    const document = createChanx({ consumers: [pinger] }).asyncapi();
    expect(Object.keys(document.operations)).toEqual(['keep_alive']);
  });

  it('camelizes names and properties when the app does, keeping schema names', () => {
    const Joined = defineMessage(
      'user_joined',
      z.object({ user_name: z.string() }).meta({ title: 'JoinedPayload' }),
    );
    const document = createChanx({
      camelize: true,
      consumers: [consumer('/ws', { name: 'chat_room' }).on(Joined, () => {})],
    }).asyncapi();

    expect(Object.keys(document.channels)).toEqual(['chatRoom']);
    expect(document.components.schemas.JoinedPayload).toMatchObject({
      properties: { userName: { type: 'string' } },
      required: ['userName'],
    });
    expect(document.operations.handleUserJoined).toMatchObject({
      channel: { $ref: '#/channels/chatRoom' },
      messages: [{ $ref: '#/channels/chatRoom/messages/userJoinedMessage' }],
    });
  });
});
