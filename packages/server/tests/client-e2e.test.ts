// @chanx-js/client against the real Node server over a socket: a second witness beside
// the client's own FakeServer suite.
import {
  ChanxRequestError,
  createClient,
  defineChannel,
  defineTopic,
} from '@chanx-js/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';

import type { Chanx } from '../src';
import {
  PingMessage,
  PongMessage,
  consumer,
  createChanx,
  defineMessage,
  topic,
} from '../src';
import type { OnCleanup } from './servers';
import { SERVERS } from './servers';

const Post = defineMessage('post', z.object({ body: z.string() }));
const Posted = defineMessage('posted', z.object({ body: z.string() }));
const RoomEvent = defineMessage('room_event', z.object({ body: z.string() }));
const Say = defineMessage('say', z.object({ text: z.string() }));
const Said = defineMessage('said', z.object({ text: z.string() }));
const Kick = defineMessage('kick');
const Joined = defineMessage('user_joined', z.object({ user_name: z.string() }));
const SetName = defineMessage('set_name', z.object({ full_name: z.string() }));
const NameSet = defineMessage('name_set', z.object({ full_name: z.string() }));

const connected = vi.fn();
const subscribed = vi.fn();
const pinged = vi.fn();

const serverRoom = topic('room:{room_name}', {
  authorize: ({ params }) => params.room_name !== 'secret',
  onSubscribe: () => subscribed(),
})
  .on(Post, { output: Posted }, async (m, ctx) => {
    await ctx.publish(RoomEvent.create(m.payload), { seq: 7 });
    return Posted.create(m.payload);
  })
  .passthrough(RoomEvent);

const serverHub = consumer('/ws/hub', {
  name: 'hub',
  emits: [Said],
  groups: ['everyone'],
  topics: [serverRoom],
  onConnect: () => connected(),
})
  .on(PingMessage, { output: PongMessage }, () => (pinged(), PongMessage.create()))
  .on(Say, (m, ctx) => ctx.broadcast(Said.create(m.payload), { excludeCurrent: true }))
  .on(Kick, (_m, ctx) => ctx.conn.close(4000, 'kicked'))
  .on(SetName, { output: NameSet }, (m) => NameSet.create(m.payload))
  .passthrough(Joined);

type ToServer =
  | { action: 'ping'; payload: null }
  | { action: 'say'; payload: { text: string } }
  | { action: 'kick'; payload: null };
type ToClient =
  | { action: 'pong'; payload: null }
  | { action: 'said'; payload: { text: string } }
  | { action: 'user_joined'; payload: { user_name: string } };
type RoomOut = { action: 'post'; payload: { body: string } };
type RoomIn = { action: 'posted' | 'room_event'; payload: { body: string } };

const roomTopic = defineTopic<RoomOut, RoomIn>()({
  name: 'room_topic',
  pattern: 'room:{room_name}',
});
const hub = defineChannel<ToServer, ToClient>()({
  name: 'hub',
  address: '/ws/hub',
  topics: { roomTopic },
  heartbeat: true,
});

const cleanups: Array<() => unknown> = [];
const onCleanup: OnCleanup = (cleanup) => void cleanups.push(cleanup);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  connected.mockClear();
  subscribed.mockClear();
  pinged.mockClear();
});

function client(
  baseUrl: string,
  options: {
    reconnectInterval?: number;
    heartbeat?: { interval: number; timeout: number };
  } = {},
) {
  const created = createClient({
    baseUrl,
    heartbeat: false as const,
    closeDelay: 0,
    socketFactory: (address) => new WebSocket(address) as never,
    ...options,
  });
  cleanups.push(() => created.closeAll());
  return created;
}

describe.each(SERVERS)(
  '@chanx-js/client against the %s adapter',
  (_name, startServer) => {
    const serve = async (chanx: Chanx = createChanx({ consumers: [serverHub] })) => ({
      chanx,
      baseUrl: await startServer(chanx, onCleanup),
    });

    it('reconnects and resubscribes after the server closes the socket', async () => {
      const { chanx, baseUrl } = await serve();
      const connection = client(baseUrl, { reconnectInterval: 20 }).connect(hub);
      const room = connection.topic(roomTopic.with({ room_name: 'lobby' }));
      await room.subscribe();

      connection.send({ action: 'kick', payload: null });

      await vi.waitFor(() => expect(subscribed).toHaveBeenCalledTimes(2));
      expect(connected).toHaveBeenCalledTimes(2);
      const event = room.once('room_event', { timeout: 2000 });
      await chanx.publish(serverRoom, 'room:lobby', RoomEvent.create({ body: 'back' }));
      expect(await event).toEqual({ action: 'room_event', payload: { body: 'back' } });
    });

    it('shares one socket between two connections, routing each reply by its ref', async () => {
      const { baseUrl } = await serve();
      const shared = client(baseUrl);
      const [a, b] = [shared.connect(hub), shared.connect(hub)];
      const [roomA, roomB] = [a, b].map((c) =>
        c.topic(roomTopic.with({ room_name: 'lobby' })),
      );
      await Promise.all([roomA!.subscribe(), roomB!.subscribe()]);

      const [replyA, replyB] = await Promise.all([
        roomA!.request({ action: 'post', payload: { body: 'from-a' } }),
        roomB!.request({ action: 'post', payload: { body: 'from-b' } }),
      ]);

      expect(connected).toHaveBeenCalledOnce();
      expect(replyA).toEqual({ action: 'posted', payload: { body: 'from-a' } });
      expect(replyB).toEqual({ action: 'posted', payload: { body: 'from-b' } });
    });

    it("broadcasts to the group's other connections, skipping the sender", async () => {
      const { baseUrl } = await serve();
      const [alice, bob] = [client(baseUrl).connect(hub), client(baseUrl).connect(hub)];
      await Promise.all([alice.ready(), bob.ready()]);
      const heardByAlice = vi.fn();
      alice.on('said', heardByAlice);

      const heard = bob.once('said', { timeout: 2000 });
      alice.send({ action: 'say', payload: { text: 'hi bob' } });

      expect(await heard).toEqual({ action: 'said', payload: { text: 'hi bob' } });
      expect(heardByAlice).not.toHaveBeenCalled();
    });

    it('delivers a server-side broadcastEvent to every connection', async () => {
      const { chanx, baseUrl } = await serve();
      const connection = client(baseUrl).connect(hub);
      await connection.ready();

      const joined = connection.once('user_joined', { timeout: 2000 });
      await chanx.broadcastEvent(serverHub, Joined.create({ user_name: 'eve' }));

      expect(await joined).toEqual({
        action: 'user_joined',
        payload: { user_name: 'eve' },
      });
    });

    it('rejects a subscribe the topic does not authorize', async () => {
      const { baseUrl } = await serve();
      const room = client(baseUrl)
        .connect(hub)
        .topic(roomTopic.with({ room_name: 'secret' }));

      const error = await room.subscribe().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChanxRequestError);
      expect((error as ChanxRequestError).frame.payload).toMatchObject({
        reason: 'unauthorized',
      });
    });

    it('speaks camelCase keys on the wire to a camelizing app; actions stay as they are', async () => {
      const { baseUrl } = await serve(
        createChanx({ consumers: [serverHub], camelize: true }),
      );
      const camel = defineChannel<
        { action: 'set_name'; payload: { fullName: string } },
        { action: 'name_set'; payload: { fullName: string } }
      >()({ name: 'hub', address: '/ws/hub' });
      const connection = client(baseUrl).connect(camel);

      expect(
        await connection.request({ action: 'set_name', payload: { fullName: 'Ann' } }),
      ).toEqual({ action: 'name_set', payload: { fullName: 'Ann' } });
    });

    it("receives a topic's events with their seq", async () => {
      const { baseUrl } = await serve();
      const room = client(baseUrl)
        .connect(hub)
        .topic(roomTopic.with({ room_name: 'lobby' }));
      const events: unknown[] = [];
      room.on('room_event', (message, envelope) => events.push([message, envelope.seq]));

      await room.subscribe();
      await room.request({ action: 'post', payload: { body: 'hi' } });

      await vi.waitFor(() =>
        expect(events).toEqual([[{ action: 'room_event', payload: { body: 'hi' } }, 7]]),
      );
    });

    it('rejects a request the server answers with an error', async () => {
      const { baseUrl } = await serve();
      const connection = client(baseUrl).connect(hub);

      await expect(
        connection.request({ action: 'say', payload: {} } as never),
      ).rejects.toBeInstanceOf(ChanxRequestError);
    });

    it("keeps a heartbeat going with chanx's ping and pong", async () => {
      const { baseUrl } = await serve();
      const connection = client(baseUrl, {
        heartbeat: { interval: 20, timeout: 500 },
      }).connect(hub);
      await connection.ready();

      await vi.waitFor(() => expect(pinged.mock.calls.length).toBeGreaterThanOrEqual(3));
      expect(connection.status).toBe('open');
    });
  },
);
