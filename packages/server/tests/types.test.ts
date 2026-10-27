// Compile-time guarantees: `pnpm typecheck` fails if any @ts-expect-error stops erroring.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ClassContext, MessageOf, TopicClassContext } from '../src';
import {
  PingMessage,
  PongMessage,
  consumer,
  createChanx,
  defineMessage,
  handlers,
  topic,
} from '../src';

class RoomService {
  constructor(readonly name: string) {}
  post(_text: string) {}
}

const Chat = defineMessage('chat', z.object({ text: z.string() }));
const History = defineMessage('history');
const HistoryResult = defineMessage('history_result', z.array(z.string()));
const Joined = defineMessage('joined', z.object({ user: z.number() }));

describe('builder types', () => {
  it('infers state, params, user, payloads and what may be sent', () => {
    const presence = handlers<{ room: RoomService }>().on(PingMessage, (_m, ctx) => {
      ctx.state.room.name satisfies string;
    });

    const chat = consumer('/ws/chat/{room}', {
      name: 'chat',
      emits: [Joined],
      authenticate: () => ({ id: 1 }),
      state: (conn) => ({ room: new RoomService(conn.params.room) }),
    })
      .use(presence)
      .on(Chat, async (m, ctx) => {
        m.payload.text satisfies string;
        ctx.state.room.post(m.payload.text);
        ctx.params.room satisfies string;
        ctx.conn.user.id satisfies number;
        await ctx.send(Joined.create({ user: 1 }));
        // @ts-expect-error: not a field of the state
        void ctx.state.rooms;
        // @ts-expect-error: not a param of the route
        void ctx.params.roomId;
        // @ts-expect-error: not in emits or this handler's outputs
        await ctx.send(PongMessage.create());
      })
      .on(History, { output: HistoryResult }, () => HistoryResult.create(['a']));

    expect(chat).toBeDefined();
  });

  it('checks replies against the declared output', () => {
    consumer('/ws', { name: 'x' })
      // @ts-expect-error: the reply is not the declared output
      .on(History, { output: HistoryResult }, () => PongMessage.create())
      // @ts-expect-error: a reply needs a declared output or a message in emits
      .on(PingMessage, () => PongMessage.create());
    expect(true).toBe(true);
  });

  it('lets a handler broadcast its declared output instead of returning it', () => {
    consumer('/ws', { name: 'x', groups: ['all'] })
      .on(Chat, { output: Joined }, (_m, ctx) =>
        ctx.broadcast(Joined.create({ user: 1 })),
      )
      .on(History, { output: HistoryResult }, async (_m, ctx) => {
        // @ts-expect-error: not this handler's output
        await ctx.broadcast(Joined.create({ user: 1 }));
      });
    expect(true).toBe(true);
  });

  it('refuses a handler set whose state the consumer lacks', () => {
    const needsRoom = handlers<{ room: RoomService }>().on(PingMessage, () => {});
    // @ts-expect-error: this consumer has no `room` in its state
    consumer('/ws', { name: 'x' }).use(needsRoom);
    expect(true).toBe(true);
  });

  it('accepts only the events a consumer handles, its sets included', async () => {
    const Alert = defineMessage('alert', z.object({ level: z.string() }));
    const set = handlers().passthrough(Alert);
    const room = consumer('/ws', { name: 'room', groups: ['all'] })
      .event(Joined, (e) => void e.payload.user)
      .use(set);
    const chanx = createChanx({ consumers: [room] });

    await chanx.broadcastEvent(room, Joined.create({ user: 1 }));
    await chanx.broadcastEvent(room, Alert.create({ level: 'high' }));
    // @ts-expect-error: the consumer handles no such event
    await chanx.broadcastEvent(room, PingMessage.create());
    const wrongPayload = { action: 'alert' as const, payload: { level: 1 } };
    // @ts-expect-error: wrong payload for a handled event
    await chanx.sendEvent(room, wrongPayload, 'asgispecific.x');
  });

  it('types topic params, replies and what may be published', async () => {
    const Posted = defineMessage('posted', z.object({ body: z.string() }));
    const room = topic('room:{room_name}', {
      authorize: ({ params }) => params.room_name !== 'secret',
    })
      .on(Chat, { output: Posted }, (m, ctx) => {
        ctx.params.room_name satisfies string;
        // @ts-expect-error: not a param of the pattern
        void ctx.params.room;
        return Posted.create({ body: m.payload.text });
      })
      .on(History, { output: Posted }, (_m, ctx) =>
        ctx.push(Posted.create({ body: 'x' })),
      )
      .passthrough(Joined);
    const chanx = createChanx({
      consumers: [consumer('/ws', { name: 'hub', topics: [room] })],
    });

    await chanx.publish(
      room,
      room.with({ room_name: 'lobby' }),
      Joined.create({ user: 1 }),
    );
    // @ts-expect-error: the topic handles no such event
    await chanx.publish(room, 'room:lobby', PongMessage.create());
    // @ts-expect-error: a missing param
    expect(() => room.with({})).toThrow('Missing parameter');
  });

  it('types created messages from their schemas', () => {
    Chat.create({ text: 'hi' }) satisfies MessageOf<typeof Chat>;
    // @ts-expect-error: wrong payload
    Chat.create({ text: 1 });
    // @ts-expect-error: a payload-less message takes none
    PingMessage.create({});
    expect(true).toBe(true);
  });
});

describe('class context types', () => {
  it('types the user as the class declares it, unknown by default, never any', () => {
    const check = (ctx: ClassContext, typed: ClassContext<{ name: string }>) => {
      // @ts-expect-error: an undeclared user is unknown
      void ctx.conn.user.name;
      typed.conn.user.name satisfies string;
      typed.state.conn.user.name satisfies string;
    };
    const checkTopic = (ctx: TopicClassContext) => {
      // @ts-expect-error: an undeclared user is unknown
      void ctx.conn.user.name;
    };
    expect([check, checkTopic]).toHaveLength(2);
  });
});
