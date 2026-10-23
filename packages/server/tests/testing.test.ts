import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  PingMessage,
  PongMessage,
  consumer,
  createChanx,
  defineMessage,
  topic,
} from '../src';
import { captureBroadcastEvents, captureTopicBroadcasts, connect } from '../src/testing';

const Post = defineMessage('post', z.object({ body: z.string() }));
const Posted = defineMessage('posted', z.object({ body: z.string() }));
const RoomEvent = defineMessage('room_event', z.object({ body: z.string() }));
const SetName = defineMessage('set_name', z.object({ full_name: z.string() }));
const NameSet = defineMessage('name_set', z.object({ full_name: z.string() }));
const Joined = defineMessage('user_joined', z.object({ user: z.string() }));

const roomTopic = topic('room:{room_name}')
  .on(Post, { output: Posted }, async (m, ctx) => {
    await ctx.publish(RoomEvent.create(m.payload), { seq: 7 });
    return Posted.create(m.payload);
  })
  .passthrough(RoomEvent);

// Same pattern, another name: its subscribers are another group.
const otherRoomTopic = topic('room:{room_name}', { name: 'OtherRoomTopic' }).passthrough(
  RoomEvent,
);

const hub = consumer('/ws/hub', {
  name: 'hub',
  groups: ['everyone'],
  topics: [roomTopic, otherRoomTopic],
})
  .on(PingMessage, { output: PongMessage }, () => PongMessage.create())
  .on(SetName, { output: NameSet }, (m) => NameSet.create(m.payload))
  .passthrough(Joined);

const app = (camelize = false) => createChanx({ consumers: [hub], camelize });

async function ready(chanx = app()) {
  const client = connect(chanx, '/ws/hub');
  await client.ready;
  return { chanx, client };
}

describe('the test client', () => {
  it('sends a created message, which a camelizing app takes as well', async () => {
    for (const camelize of [false, true]) {
      const { client } = await ready(app(camelize));
      client.sendMessage(SetName.create({ full_name: 'Ann' }), { ref: 'r1' });
      const key = camelize ? 'fullName' : 'full_name';
      expect(await client.receive()).toEqual({
        action: 'name_set',
        payload: { [key]: 'Ann' },
        version: 1,
        ref: 'r1',
      });
    }
  });

  it('subscribes and unsubscribes, resolving with the replies', async () => {
    const { client } = await ready();
    expect(await client.subscribe('room:lobby')).toMatchObject({
      action: 'subscribed',
      topic: 'room:lobby',
    });
    expect(await client.unsubscribe('room:lobby')).toMatchObject({
      action: 'unsubscribed',
      topic: 'room:lobby',
    });
  });

  it('collects every frame until the server goes quiet', async () => {
    const { client } = await ready();
    for (let i = 0; i < 3; i++) client.send({ action: 'ping' });
    expect(await client.receiveAll()).toEqual(
      Array.from({ length: 3 }, () => ({ action: 'pong', payload: null })),
    );
  });

  it('tells whether nothing arrives, keeping a frame that does', async () => {
    const { client } = await ready();
    expect(await client.receiveNothing({ timeout: 20 })).toBe(true);

    client.send({ action: 'ping' });
    expect(await client.receiveNothing()).toBe(false);
    expect(await client.receive()).toEqual({ action: 'pong', payload: null });
  });
});

describe('captureBroadcastEvents', () => {
  it('records broadcastEvent calls without delivering them', async () => {
    const { chanx, client } = await ready();
    const capture = captureBroadcastEvents(chanx, hub);

    await chanx.broadcastEvent(hub, Joined.create({ user: 'bob' }));
    await chanx.broadcastEvent(hub, Joined.create({ user: 'eve' }), ['everyone']);

    expect(capture.captured).toEqual([
      { event: Joined.create({ user: 'bob' }), groups: undefined },
      { event: Joined.create({ user: 'eve' }), groups: ['everyone'] },
    ]);
    expect(await client.receiveNothing()).toBe(true);
  });

  it('delivers as well when not suppressed, and stops on restore', async () => {
    const { chanx, client } = await ready();
    const capture = captureBroadcastEvents(chanx, hub, { suppress: false });

    await chanx.broadcastEvent(hub, Joined.create({ user: 'bob' }));
    expect(await client.receive()).toEqual(Joined.create({ user: 'bob' }));

    capture.restore();
    await chanx.broadcastEvent(hub, Joined.create({ user: 'eve' }));
    expect(capture.captured).toHaveLength(1);
    expect(await client.receive()).toEqual(Joined.create({ user: 'eve' }));
  });
});

describe('captureTopicBroadcasts', () => {
  it("records a handler's ctx.publish and chanx.publish, without delivering them", async () => {
    const { chanx, client } = await ready();
    await client.subscribe('room:lobby');
    const capture = captureTopicBroadcasts(chanx, roomTopic);

    await client.request(
      { action: 'post', payload: { body: 'hi' } },
      { topic: 'room:lobby' },
    );
    await chanx.publish(roomTopic, 'room:lobby', RoomEvent.create({ body: 'news' }));
    await chanx.publish(
      otherRoomTopic,
      'room:lobby',
      RoomEvent.create({ body: 'other' }),
    );

    expect(capture.captured).toEqual([
      { topic: 'room:lobby', event: RoomEvent.create({ body: 'hi' }), seq: 7 },
      { topic: 'room:lobby', event: RoomEvent.create({ body: 'news' }), seq: undefined },
    ]);
    expect(await client.receiveNothing()).toBe(true);
  });

  it('delivers as well when not suppressed, and stops on restore', async () => {
    const { chanx, client } = await ready();
    await client.subscribe('room:lobby');
    const capture = captureTopicBroadcasts(chanx, roomTopic, { suppress: false });

    await chanx.publish(roomTopic, 'room:lobby', RoomEvent.create({ body: 'news' }));
    expect(await client.receive()).toMatchObject({
      action: 'room_event',
      topic: 'room:lobby',
    });

    capture.restore();
    await chanx.publish(roomTopic, 'room:lobby', RoomEvent.create({ body: 'more' }));
    expect(capture.captured).toHaveLength(1);
    expect(await client.receive()).toMatchObject({ payload: { body: 'more' } });
  });
});
