import { InMemoryChannelLayer } from '@chanx-js/layers';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ChanxOptions } from '../src';
import { consumer, createChanx, defineMessage } from '../src';
import { connect } from '../src/testing';

const Say = defineMessage('say', z.object({ text: z.string() }));
const Said = defineMessage('said', z.object({ text: z.string() }));
const Joined = defineMessage(
  'user_joined',
  z.object({ user: z.string(), room_id: z.number() }),
);
const JoinedNotice = defineMessage(
  'user_joined_notice',
  z.object({ user: z.string(), room_id: z.number() }),
);
const Alert = defineMessage('alert', z.object({ level: z.string() }));
const Shout = defineMessage('shout');

const room = consumer('/ws/room/{name}', {
  name: 'room',
  emits: [Said],
  groups: (conn) => [`room.${conn.params.name}`],
})
  .on(Say, async (m, ctx) => ctx.broadcast(Said.create(m.payload)))
  .on(Shout, async (_m, ctx) =>
    ctx.broadcast(Said.create({ text: 'not me' }), { excludeCurrent: true }),
  )
  .event(Joined, { output: JoinedNotice }, (e) => JoinedNotice.create(e.payload))
  .passthrough(Alert);

function app(options: Partial<ChanxOptions> = {}) {
  const logger = { error: vi.fn(), warn: vi.fn() };
  return { logger, chanx: createChanx({ consumers: [room], logger, ...options }) };
}

describe('broadcasting to groups', () => {
  it('reaches every connection in the group, and only that group', async () => {
    const { chanx } = app();
    const ann = connect(chanx, '/ws/room/lobby');
    const bob = connect(chanx, '/ws/room/lobby');
    const eve = connect(chanx, '/ws/room/other');
    await Promise.all([ann.ready, bob.ready, eve.ready]);

    ann.send(Say.create({ text: 'hi' }));

    expect(await ann.receive()).toEqual({ action: 'said', payload: { text: 'hi' } });
    expect(await bob.receive()).toEqual({ action: 'said', payload: { text: 'hi' } });
    await expect(eve.receive({ timeout: 50 })).rejects.toThrow('No frame');
  });

  it('skips the sender with excludeCurrent, as exclude_current does', async () => {
    const { chanx } = app();
    const ann = connect(chanx, '/ws/room/lobby');
    const bob = connect(chanx, '/ws/room/lobby');
    await Promise.all([ann.ready, bob.ready]);

    ann.send({ action: 'shout' });

    expect(await bob.receive()).toMatchObject({ payload: { text: 'not me' } });
    await expect(ann.receive({ timeout: 50 })).rejects.toThrow('No frame');
  });

  it('follows each group message with group_complete when completion is on', async () => {
    const { chanx } = app({ sendCompletion: true });
    const ann = connect(chanx, '/ws/room/lobby');
    const bob = connect(chanx, '/ws/room/lobby');
    await Promise.all([ann.ready, bob.ready]);

    ann.send(Say.create({ text: 'hi' }));

    expect(await bob.receiveUntil('group_complete')).toEqual([
      { action: 'said', payload: { text: 'hi' } },
      { action: 'group_complete', payload: null },
    ]);
  });

  it('stops reaching a connection once it closes', async () => {
    const { chanx } = app();
    const ann = connect(chanx, '/ws/room/lobby');
    const bob = connect(chanx, '/ws/room/lobby');
    await Promise.all([ann.ready, bob.ready]);
    await bob.close();

    await chanx.broadcastEvent(room, Joined.create({ user: 'cat', room_id: 1 }), [
      'room.lobby',
    ]);

    expect((await ann.receive()).action).toBe('user_joined_notice');
    expect(bob.pending).toEqual([]);
  });

  it("closes the connection's layer channel, leaving its groups", async () => {
    const closed: string[] = [];
    class Recording extends InMemoryChannelLayer {
      override async newChannel(...args: Parameters<InMemoryChannelLayer['newChannel']>) {
        const channel = await super.newChannel(...args);
        return {
          name: channel.name,
          close: async () => {
            closed.push(channel.name);
            await channel.close();
          },
        };
      }
    }
    const chanx = createChanx({
      consumers: [room],
      layers: { default: new Recording() },
    });
    const client = connect(chanx, '/ws/room/lobby');
    await client.ready;

    await client.close();

    expect(closed).toHaveLength(1);
  });

  it('joins and leaves groups as the connection asks', async () => {
    const Follow = defineMessage('follow', z.object({ topic: z.string() }));
    const Unfollow = defineMessage('unfollow', z.object({ topic: z.string() }));
    const Done = defineMessage('done');
    const feed = consumer('/ws/feed', { name: 'feed' })
      .on(Follow, { output: Done }, async (m, ctx) => {
        await ctx.conn.join(m.payload.topic);
        return Done.create();
      })
      .on(Unfollow, { output: Done }, async (m, ctx) => {
        await ctx.conn.leave(m.payload.topic);
        return Done.create();
      })
      .passthrough(Alert);
    const chanx = createChanx({ consumers: [feed] });
    const client = connect(chanx, '/ws/feed');

    await client.request(Follow.create({ topic: 'alerts' }));
    await chanx.broadcastEvent(feed, Alert.create({ level: 'high' }), ['alerts']);
    expect(await client.receive()).toEqual({
      action: 'alert',
      payload: { level: 'high' },
    });

    await client.request(Unfollow.create({ topic: 'alerts' }));
    await chanx.broadcastEvent(feed, Alert.create({ level: 'low' }), ['alerts']);
    await expect(client.receive({ timeout: 50 })).rejects.toThrow('No frame');
  });
});

describe('events', () => {
  it('routes an event to its handler and sends what it returns', async () => {
    const { chanx } = app();
    const client = connect(chanx, '/ws/room/lobby');
    await Promise.all([client.ready]);

    await chanx.broadcastEvent(room, Joined.create({ user: 'ann', room_id: 7 }), [
      'room.lobby',
    ]);

    expect(await client.receive()).toEqual({
      action: 'user_joined_notice',
      payload: { user: 'ann', room_id: 7 },
    });
  });

  it('forwards passthrough events unchanged, and lets an explicit handler win', async () => {
    const Override = defineMessage('alert_override', z.object({ level: z.string() }));
    const both = consumer('/ws', { name: 'both', groups: ['all'] })
      .event(Alert, { output: Override }, (e) => Override.create(e.payload))
      .passthrough(Alert, Said);
    const chanx = createChanx({ consumers: [both] });
    const client = connect(chanx, '/ws');
    await Promise.all([client.ready]);

    await chanx.broadcastEvent(both, Alert.create({ level: 'high' }));
    await chanx.broadcastEvent(both, Said.create({ text: 'hi' }));

    expect(await client.receive()).toEqual({
      action: 'alert_override',
      payload: { level: 'high' },
    });
    expect(await client.receive()).toEqual({ action: 'said', payload: { text: 'hi' } });
  });

  it('sends to one connection by its channel name', async () => {
    const Whoami = defineMessage('whoami');
    const Name = defineMessage('name', z.object({ channel: z.string() }));
    const direct = consumer('/ws', { name: 'direct' })
      .on(Whoami, { output: Name }, (_m, ctx) =>
        Name.create({ channel: ctx.conn.channelName }),
      )
      .passthrough(Alert);
    const chanx = createChanx({ consumers: [direct] });
    const ann = connect(chanx, '/ws');
    const bob = connect(chanx, '/ws');

    const { payload } = await ann.request({ action: 'whoami' });
    await chanx.sendEvent(
      direct,
      Alert.create({ level: 'only ann' }),
      (payload as { channel: string }).channel,
    );

    expect(await ann.receive()).toEqual({
      action: 'alert',
      payload: { level: 'only ann' },
    });
    await expect(bob.receive({ timeout: 50 })).rejects.toThrow('No frame');
  });

  it('logs an invalid event and sends nothing, as chanx does', async () => {
    const { chanx, logger } = app({ sendCompletion: true });
    const client = connect(chanx, '/ws/room/lobby');
    await Promise.all([client.ready]);

    await chanx.broadcastEvent(
      room,
      { action: 'user_joined', payload: { user: 1 } } as never,
      ['room.lobby'],
    );

    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        'chanx: channel event failed validation',
        expect.any(Array),
      ),
    );
    expect(client.pending).toEqual([]);
  });

  it('logs a failing event handler, still completing, and tells the client nothing else', async () => {
    const failing = consumer('/ws', { name: 'failing', groups: ['all'] }).event(
      Alert,
      () => {
        throw new Error('boom');
      },
    );
    const logger = { error: vi.fn(), warn: vi.fn() };
    const chanx = createChanx({ consumers: [failing], logger, sendCompletion: true });
    const client = connect(chanx, '/ws');
    await Promise.all([client.ready]);

    await chanx.broadcastEvent(failing, Alert.create({ level: 'x' }));

    expect(await client.receive()).toEqual({ action: 'event_complete', payload: null });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('alert'),
      expect.any(Error),
    );
  });

  it('holds layer messages until onConnect has finished', async () => {
    let release!: () => void;
    const slow = consumer('/ws', {
      name: 'slow',
      groups: ['all'],
      onConnect: () => new Promise<void>((resolve) => (release = resolve)),
    }).passthrough(Alert);
    const chanx = createChanx({ consumers: [slow] });
    const client = connect(chanx, '/ws');
    await vi.waitFor(() => expect(release).toBeDefined());

    await chanx.broadcastEvent(slow, Alert.create({ level: 'early' }));
    await expect(client.receive({ timeout: 50 })).rejects.toThrow('No frame');

    release();
    expect(await client.receive()).toEqual({
      action: 'alert',
      payload: { level: 'early' },
    });
  });

  it('refuses to guess groups for a consumer whose groups depend on the connection', async () => {
    await expect(
      app().chanx.broadcastEvent(room, Joined.create({ user: 'a', room_id: 1 })),
    ).rejects.toThrow('has no fixed ones');
  });

  it('uses the layer the consumer names', async () => {
    const chat = new InMemoryChannelLayer();
    const named = consumer('/ws', {
      name: 'named',
      layer: 'chat',
      groups: ['all'],
    }).passthrough(Alert);
    const chanx = createChanx({
      consumers: [named],
      layers: { default: new InMemoryChannelLayer(), chat },
    });
    const client = connect(chanx, '/ws');
    await Promise.all([client.ready]);

    await chat.groupSend('all', {
      type: 'handle_channel_event',
      event_data: Alert.create({ level: 'x' }),
    });

    expect(await client.receive()).toEqual({ action: 'alert', payload: { level: 'x' } });
    expect(() =>
      createChanx({ consumers: [named] }).connect(
        { url: '/ws' },
        { send() {}, close() {} },
      ),
    ).toThrow('No channel layer named "chat"');
  });
});
