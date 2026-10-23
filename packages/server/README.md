# @chanx-js/server

chanx for Node: typed WebSocket consumers speaking the same protocol as Python's
[chanx](https://github.com/huynguyengl99/chanx), so `@chanx-js/client` and generated
clients work against either server.

In development; see the repository's design notes. Not yet published.

```ts
import { z } from 'zod';
import {
  PingMessage,
  PongMessage,
  consumer,
  createChanx,
  defineMessage,
} from '@chanx-js/server';

const Chat = defineMessage('chat', z.object({ text: z.string() }));
const Notice = defineMessage('notice', z.object({ text: z.string() }));

const chat = consumer('/ws/chat/{room}', { name: 'chat', emits: [Notice] })
  .on(PingMessage, { output: PongMessage }, () => PongMessage.create())
  .on(Chat, async (m, ctx) => {
    await ctx.send(Notice.create({ text: `${ctx.params.room}: ${m.payload.text}` }));
  });

export const chanx = createChanx({ consumers: [chat] });
```

## Serving it

`@chanx-js/server/node` serves an app on any Node HTTP server, through
[`ws`](https://github.com/websockets/ws) (a peer dependency): plain `http`, or the
server under Express, Fastify, Koa or NestJS.

```ts
import { createServer } from 'node:http';
import { attachChanx } from '@chanx-js/server/node';

const server = createServer(expressApp); // or nestApp.getHttpServer(), fastify.server
attachChanx(server, chanx);
server.listen(8000);
```

Only upgrades for paths a consumer serves are taken, so other WebSocket servers can
share the HTTP server. Clients are pinged every 20 seconds and dropped when they stop
answering, as uvicorn does for Python's chanx.

## Groups and events

Connections join groups through a [channel layer](../layers): in-memory by default, or
Redis shared with other Node and Python processes.

```ts
import { RedisPubSubChannelLayer } from '@chanx-js/layers/redis';

const room = consumer('/ws/room/{name}', {
  name: 'room',
  emits: [Said],
  groups: (conn) => [`room.${conn.params.name}`],
})
  .on(Say, (m, ctx) => ctx.broadcast(Said.create(m.payload), { excludeCurrent: true }))
  .event(UserJoined, { output: JoinedNotice }, (e) => JoinedNotice.create(e.payload))
  .passthrough(Alert);

const chanx = createChanx({
  consumers: [room],
  layers: { default: new RedisPubSubChannelLayer({ hosts: [process.env.REDIS_URL!] }) },
});

// From anywhere, typed against the events `room` handles:
await chanx.broadcastEvent(room, UserJoined.create({ user: 'ann' }), ['room.lobby']);
```

The layer messages are chanx's own (`handle_channel_event`, `handle_group_message`),
so a Python worker's `broadcast_event` reaches Node connections, and back.

## Topics

One connection, many streams: clients subscribe to topics by name, each with its own
handlers and authorization, as in chanx.

```ts
import { topic } from '@chanx-js/server';

const roomTopic = topic('room:{room_name}', {
  authorize: ({ params, conn }) => canJoin(conn.user, params.room_name),
  onSubscribe: (ctx) => ctx.send(History.create(await history(ctx.params.room_name))),
})
  .on(Post, { output: Posted }, async (m, ctx) => {
    await ctx.publish(RoomEvent.create(m.payload));
    return Posted.create(m.payload);
  })
  .passthrough(RoomEvent);

const hub = consumer('/ws/hub', { name: 'hub', topics: [roomTopic] });

// From anywhere; `seq` is caller-assigned, for gap detection:
await chanx.publish(roomTopic, roomTopic.with({ room_name: 'lobby' }), event, {
  seq: 42,
});

// The same topic alone on a route, subscribed from the URL:
const room = roomTopic.asConsumer('/ws/room/{room_name}');
```

Group names follow chanx (`RoomTopic.room-lobby`), so Python and Node publish to the
same subscribers.

## Classes

The same consumer as a class, for shared logic, base classes and hooks to override. One
instance serves one connection, so its fields are per-connection state:

```ts
import { AsyncJsonWebsocketConsumer, Consumer, On } from '@chanx-js/server';

@Consumer('/ws/chat/{room}', { name: 'chat', emits: [Notice] })
class ChatConsumer extends AsyncJsonWebsocketConsumer {
  @On(PingMessage, { output: PongMessage })
  ping() {
    return PongMessage.create();
  }

  @On(Chat)
  async chat(m: MessageOf<typeof Chat>, ctx: ClassContext) {
    await ctx.send(Notice.create({ text: `${this.params.room}: ${m.payload.text}` }));
  }
}
```

The decorators work with standard decorators and with `experimentalDecorators` (as
NestJS uses). As in chanx, a subclass method overrides the handler of the same name, and
two methods handling one action are an error.

Payloads are validated by any [Standard Schema](https://standardschema.dev) library:
Zod, Valibot, ArkType and others. Validation errors reach the client in the shape
chanx's pydantic errors have.

`@chanx-js/server/testing` connects to an app in-process, without a network:

```ts
import { connect } from '@chanx-js/server/testing';

const client = connect(chanx, '/ws/chat/lobby');
const reply = await client.request({ action: 'ping' });
```
