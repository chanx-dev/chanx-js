import { InMemoryChannelLayer } from '@chanx-js/layers';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { MessageOf, TopicClassContext } from '../src';
import {
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
import type { Frame, TestClient } from '../src/testing';
import { connect } from '../src/testing';

const PostPayload = z.object({ body: z.string() });
const Post = defineMessage('post', PostPayload);
const Posted = defineMessage('posted', PostPayload);
const RoomEvent = defineMessage('room_event', PostPayload);

// chanx's sandbox RoomTopic and a hub mounting it, rebuilt on the Node server.
const roomTopic = topic('room:{room_name}', {
  authorize: ({ params }) => params.room_name !== 'secret',
  // As chanx's send_message: state, so it must not carry the subscribe's ref.
  onSubscribe: (ctx) => ctx.send(Posted.create({ body: 'welcome' })),
})
  .on(Post, { output: Posted }, async (m, ctx) => {
    await ctx.publish(RoomEvent.create(m.payload), { seq: 5 });
    return Posted.create(m.payload);
  })
  .passthrough(RoomEvent);

const hub = consumer('/ws/hub', { name: 'hub', topics: [roomTopic] }).on(
  PingMessage,
  { output: PongMessage },
  () => PongMessage.create(),
);

const app = () => createChanx({ consumers: [hub], logger: { error() {}, warn() {} } });

// The same topic as chanx's sandbox writes it: a class with a pattern and handler methods.
class RoomTopic extends Topic {
  static override pattern = 'room:{room_name}';
  static override passthrough = [RoomEvent];

  override authorize() {
    return this.params.room_name !== 'secret';
  }

  override async onSubscribe() {
    await this.push(Posted.create({ body: 'welcome' }));
  }

  @On(Post, { output: Posted })
  async handle_post(m: MessageOf<typeof Post>) {
    await this.publish(RoomEvent.create(m.payload), { seq: 5 });
    return Posted.create(m.payload);
  }
}

const classHub = consumer('/ws/hub', { name: 'hub', topics: [RoomTopic] }).on(
  PingMessage,
  { output: PongMessage },
  () => PongMessage.create(),
);

/** Everything the server sends until it goes quiet, as chanx's communicator collects it. */
async function drain(client: TestClient) {
  const frames: Frame[] = [];
  for (;;) {
    try {
      frames.push(await client.receive({ timeout: 30 }));
    } catch {
      return frames;
    }
  }
}

describe.each([
  ['a topic() builder', () => app()],
  [
    'a Topic class',
    () => createChanx({ consumers: [classHub], logger: { error() {}, warn() {} } }),
  ],
])('topics as %s, against a chanx transcript', (_surface, makeApp) => {
  it('answers every frame as chanx 2.11.7 does', async () => {
    const client = connect(makeApp(), '/ws/hub');
    await client.ready;
    const sent = [
      { version: 1, topic: 'room:lobby', ref: '1', action: 'subscribe' },
      { version: 1, topic: 'room:lobby', ref: '2', action: 'subscribe' },
      {
        version: 1,
        topic: 'room:lobby',
        ref: '3',
        action: 'post',
        payload: { body: 'hi' },
      },
      { version: 1, topic: 'room:lobby', ref: '4', action: 'post', payload: { body: 5 } },
      { version: 1, topic: 'room:secret', ref: '5', action: 'subscribe' },
      { version: 1, topic: 'nope:x', ref: '6', action: 'subscribe' },
      {
        version: 1,
        topic: 'room:other',
        ref: '7',
        action: 'post',
        payload: { body: 'x' },
      },
      { version: 1, topic: 'room:lobby', ref: '8', action: 'unsubscribe' },
      { version: 1, topic: 'room:lobby', ref: '9', action: 'unsubscribe' },
    ];
    const frames: Frame[] = [];
    for (const frame of sent) {
      client.send(frame);
      frames.push(...(await drain(client)));
    }

    // Recorded from chanx 2.11.7 with fast-channels' in-memory layer, for the same frames.
    expect(frames).toEqual([
      { action: 'subscribed', payload: null, version: 1, topic: 'room:lobby', ref: '1' },
      { action: 'posted', payload: { body: 'welcome' }, version: 1, topic: 'room:lobby' },
      { action: 'subscribed', payload: null, version: 1, topic: 'room:lobby', ref: '2' },
      {
        action: 'posted',
        payload: { body: 'hi' },
        version: 1,
        topic: 'room:lobby',
        ref: '3',
      },
      {
        action: 'room_event',
        payload: { body: 'hi' },
        version: 1,
        topic: 'room:lobby',
        seq: 5,
      },
      {
        action: 'error',
        payload: [
          {
            type: 'value_error',
            loc: ['post', 'payload', 'body'],
            msg: expect.any(String),
          },
        ],
        version: 1,
        topic: 'room:lobby',
        ref: '4',
      },
      {
        action: 'error',
        payload: {
          reason: 'unauthorized',
          detail: "Not allowed to subscribe to 'room:secret'",
        },
        version: 1,
        topic: 'room:secret',
        ref: '5',
      },
      {
        action: 'error',
        payload: { reason: 'unknown_topic', detail: "Unknown topic 'nope:x'" },
        version: 1,
        topic: 'nope:x',
        ref: '6',
      },
      {
        action: 'error',
        payload: { reason: 'not_subscribed', detail: "Not subscribed to 'room:other'" },
        version: 1,
        topic: 'room:other',
        ref: '7',
      },
      {
        action: 'unsubscribed',
        payload: null,
        version: 1,
        topic: 'room:lobby',
        ref: '8',
      },
      {
        action: 'unsubscribed',
        payload: null,
        version: 1,
        topic: 'room:lobby',
        ref: '9',
      },
    ]);
  });
});

describe('topics', () => {
  it('reach every subscriber of a topic, and only of that topic', async () => {
    const chanx = app();
    const [ann, bob, eve] = ['/ws/hub', '/ws/hub', '/ws/hub'].map((url) =>
      connect(chanx, url),
    );
    await Promise.all([ann!.ready, bob!.ready, eve!.ready]);
    for (const [client, value] of [
      [ann!, 'room:lobby'],
      [bob!, 'room:lobby'],
      [eve!, 'room:hall'],
    ] as const) {
      await client.request({ action: 'subscribe' }, { topic: value });
      await client.receive(); // welcome
    }

    await chanx.publish(roomTopic, 'room:lobby', RoomEvent.create({ body: 'news' }), {
      seq: 9,
    });

    const expected = {
      action: 'room_event',
      payload: { body: 'news' },
      version: 1,
      topic: 'room:lobby',
      seq: 9,
    };
    expect(await ann!.receive()).toEqual(expected);
    expect(await bob!.receive()).toEqual(expected);
    await expect(eve!.receive({ timeout: 50 })).rejects.toThrow('No frame');
  });

  it('stop reaching a connection that unsubscribed or left, running onUnsubscribe once each', async () => {
    const left: string[] = [];
    const discarded: string[] = [];
    class Recording extends InMemoryChannelLayer {
      override async groupDiscard(group: string, channel: string) {
        discarded.push(group);
        await super.groupDiscard(group, channel);
      }
    }
    const watched = topic('room:{room_name}', {
      onUnsubscribe: (ctx) => void left.push(ctx.topic),
    }).passthrough(RoomEvent);
    const chanx = createChanx({
      consumers: [consumer('/ws', { name: 'w', topics: [watched] })],
      layers: { default: new Recording() },
    });
    const client = connect(chanx, '/ws');
    await client.ready;
    await client.request({ action: 'subscribe' }, { topic: 'room:a' });
    await client.request({ action: 'subscribe' }, { topic: 'room:b' });

    await client.request({ action: 'unsubscribe' }, { topic: 'room:a' });
    expect(discarded).toEqual(['RoomTopic.room-a']);
    await chanx.publish(watched, 'room:a', RoomEvent.create({ body: 'gone' }));
    await expect(client.receive({ timeout: 50 })).rejects.toThrow('No frame');

    await client.close();
    expect(left).toEqual(['room:a', 'room:b']);
  });

  it('serve one topic on its own route, subscribed from the URL, frames without an envelope', async () => {
    const chanx = createChanx({
      consumers: [roomTopic.asConsumer('/ws/room/{room_name}')],
    });
    const client = connect(chanx, '/ws/room/lobby');

    expect(await client.receive()).toEqual({
      action: 'subscribed',
      payload: null,
      version: 1,
      topic: 'room:lobby',
    });
    expect((await client.receive()).payload).toEqual({ body: 'welcome' });
    client.send({ action: 'post', payload: { body: 'hi' } });
    expect(await client.receive()).toMatchObject({
      action: 'posted',
      topic: 'room:lobby',
    });
  });

  it('refuses to publish on a string the topic does not match', async () => {
    await expect(
      app().publish(roomTopic, 'hall:1', RoomEvent.create({ body: 'x' })),
    ).rejects.toThrow('not a topic of pattern');
  });

  it('builds topic strings from params', () => {
    expect(roomTopic.with({ room_name: 'lobby' })).toBe('room:lobby');
  });

  it('rejects two handlers for one action on a topic', () => {
    expect(() =>
      topic('x:{id}')
        .on(Post, () => {})
        .on(Post, () => {}),
    ).toThrow('Topic "x:{id}" has two message handlers for action "post"');
  });

  it('logs and drops an invalid topic event', async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const chanx = createChanx({ consumers: [hub], logger });
    const client = connect(chanx, '/ws/hub');
    await client.ready;
    await client.request({ action: 'subscribe' }, { topic: 'room:lobby' });
    await client.receive();

    await chanx.publish(roomTopic, 'room:lobby', {
      action: 'room_event',
      payload: { body: 1 },
    } as never);

    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        'chanx: channel event failed validation',
        expect.any(Array),
      ),
    );
    expect(client.pending).toEqual([]);
  });
});

describe('Topic classes', () => {
  it('get an instance per subscription, so fields are per-subscription state', async () => {
    const Bump = defineMessage('bump');
    const Count = defineMessage('count', z.object({ n: z.number(), topic: z.string() }));
    class CounterTopic extends Topic {
      static override pattern = 'counter:{id}';
      private n = 0;

      @On(Bump, { output: Count })
      bump(_m: unknown, ctx: TopicClassContext) {
        return Count.create({ n: ++this.n, topic: ctx.topic });
      }
    }
    const chanx = createChanx({
      consumers: [consumer('/ws', { name: 'c', topics: [CounterTopic] })],
    });
    const client = connect(chanx, '/ws');
    await client.ready;
    for (const value of ['counter:a', 'counter:b']) {
      await client.request({ action: 'subscribe' }, { topic: value });
    }

    const bump = async (value: string) =>
      (await client.request({ action: 'bump' }, { topic: value })).payload;
    expect(await bump('counter:a')).toEqual({ n: 1, topic: 'counter:a' });
    expect(await bump('counter:a')).toEqual({ n: 2, topic: 'counter:a' });
    expect(await bump('counter:b')).toEqual({ n: 1, topic: 'counter:b' });
  });

  it('name their layer group after the class, as chanx does', async () => {
    const joined: string[] = [];
    class Recording extends InMemoryChannelLayer {
      override async groupAdd(group: string, channel: string) {
        joined.push(group);
        await super.groupAdd(group, channel);
      }
    }
    const chanx = createChanx({
      consumers: [classHub],
      layers: { default: new Recording() },
    });
    const client = connect(chanx, '/ws/hub');
    await client.ready;

    await client.request({ action: 'subscribe' }, { topic: 'room:lobby' });

    expect(joined).toEqual(['RoomTopic.room-lobby']);
  });

  it('run their unsubscribe hook on unsubscribe and on disconnect', async () => {
    const left: string[] = [];
    class Watched extends Topic {
      static override pattern = 'w:{id}';
      override onUnsubscribe() {
        left.push(this.topic);
      }
    }
    const chanx = createChanx({
      consumers: [consumer('/ws', { name: 'w', topics: [Watched] })],
    });
    const client = connect(chanx, '/ws');
    await client.ready;
    await client.request({ action: 'subscribe' }, { topic: 'w:1' });
    await client.request({ action: 'subscribe' }, { topic: 'w:2' });

    await client.request({ action: 'unsubscribe' }, { topic: 'w:1' });
    await client.close();

    expect(left).toEqual(['w:1', 'w:2']);
  });

  it('serve alone on a route', async () => {
    const chanx = createChanx({
      consumers: [topicConsumer(RoomTopic, '/ws/room/{room_name}')],
    });
    const client = connect(chanx, '/ws/room/lobby');

    expect(await client.receive()).toMatchObject({
      action: 'subscribed',
      topic: 'room:lobby',
    });
    expect((await client.receive()).payload).toEqual({ body: 'welcome' });
  });

  it('publish from anywhere', async () => {
    const chanx = createChanx({ consumers: [classHub] });
    const client = connect(chanx, '/ws/hub');
    await client.ready;
    await client.request({ action: 'subscribe' }, { topic: 'room:lobby' });
    await client.receive();

    await chanx.publish(RoomTopic, 'room:lobby', RoomEvent.create({ body: 'news' }));

    expect((await client.receive()).payload).toEqual({ body: 'news' });
  });

  it('refuse a class without a pattern', () => {
    class NoPattern extends Topic {}
    expect(() =>
      createChanx({
        consumers: [consumer('/ws', { name: 'x', topics: [NoPattern] })],
      }).asyncapi(),
    ).toThrow('NoPattern is not a topic');
  });
});

describe('topic() state', () => {
  it('is built per subscription, before authorize', async () => {
    const seen: string[] = [];
    const tracked = topic('t:{id}', {
      state: ({ params }) => ({ id: params.id!, hits: 0 }),
      authorize: ({ state }) => {
        seen.push(state.id);
        return true;
      },
    }).on(Post, { output: Posted }, (_m, ctx) =>
      Posted.create({ body: `${ctx.state.id}:${++ctx.state.hits}` }),
    );
    const chanx = createChanx({
      consumers: [consumer('/ws', { name: 't', topics: [tracked] })],
    });
    const client = connect(chanx, '/ws');
    await client.ready;
    await client.request({ action: 'subscribe' }, { topic: 't:a' });

    const post = async () =>
      (await client.request({ action: 'post', payload: { body: '' } }, { topic: 't:a' }))
        .payload;
    expect(await post()).toEqual({ body: 'a:1' });
    expect(await post()).toEqual({ body: 'a:2' });
    expect(seen).toEqual(['a']);
  });
});
