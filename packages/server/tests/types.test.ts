// Compile-time guarantees: `pnpm typecheck` fails if any @ts-expect-error stops erroring.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { MessageOf } from '../src';
import { PingMessage, PongMessage, consumer, defineMessage, handlers } from '../src';

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

  it('refuses a handler set whose state the consumer lacks', () => {
    const needsRoom = handlers<{ room: RoomService }>().on(PingMessage, () => {});
    // @ts-expect-error: this consumer has no `room` in its state
    consumer('/ws', { name: 'x' }).use(needsRoom);
    expect(true).toBe(true);
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
