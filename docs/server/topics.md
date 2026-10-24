# Topics

A topic is a stream a client subscribes to by name, such as `room:lobby`, with its own
handlers and authorization. One connection can hold many, which is what
[topics on the client](/client/topics) build on.

## Define a topic

A pattern names the topic family; its params come from the subscribed name:

```ts
import { topic } from '@chanx-js/server';

const roomTopic = topic('room:{room_name}', {
  authorize: ({ params, conn }) => canJoin(conn.user, params.room_name),
  onSubscribe: async (ctx) =>
    ctx.send(History.create(await history(ctx.params.room_name))),
})
  .on(Post, { output: Posted }, async (m, ctx) => {
    await ctx.publish(RoomEvent.create(m.payload));
    return Posted.create(m.payload);
  })
  .passthrough(RoomEvent);

const hub = consumer('/ws/hub', { name: 'hub', topics: [roomTopic] });
```

- `authorize` decides whether a connection may subscribe. A refusal answers with an
  `error` whose reason is `unauthorized`.
- `onSubscribe` runs once subscribed. What it sends is state, not a reply, so it carries
  no `ref`. `onUnsubscribe` runs on unsubscribe and on disconnect.
- `state` builds per-subscription state, available as `ctx.state`.
- Handlers reply as a consumer's do, on the topic.

## Publish

`ctx.publish()` in a handler, or `chanx.publish()` from anywhere, reaches every
subscriber in every process:

```ts
await chanx.publish(roomTopic, roomTopic.with({ room_name: 'lobby' }), event, {
  seq: 42,
});
```

`roomTopic.with(params)` builds the topic name. `seq` is yours to assign, for the
client's gap detection only; leave it unset when several writers publish.

## A topic on its own route

`asConsumer` serves one topic alone, subscribed from the URL, with no envelope needed:

```ts
const room = roomTopic.asConsumer('/ws/room/{room_name}');
```

## Classes

One instance serves one subscription. The class name names the layer group, so two
servers sharing a layer must use the same name:

```ts
import { On, Topic } from '@chanx-js/server';

class RoomTopic extends Topic {
  static override pattern = 'room:{room_name}';
  static override passthrough = [RoomEvent];

  override authorize() {
    return this.params.room_name !== 'secret';
  }

  @On(Post, { output: Posted })
  async post(m: MessageOf<typeof Post>) {
    await this.publish(RoomEvent.create(m.payload));
    return Posted.create(m.payload);
  }
}

consumer('/ws/hub', { name: 'hub', topics: [RoomTopic] });
```

`topicConsumer(RoomTopic, '/ws/room/{room_name}')` serves a class topic on its own
route.

## Group names

A topic's subscribers form a layer group named as chanx names it, such as
`RoomTopic.room-lobby`. A builder topic defaults to `RoomTopic` for `room:{...}`; set
`name` to change it. Python and Node processes publishing to the same topic reach the
same subscribers.
