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

Or as a class, for shared logic, base classes and hooks to override. One instance
serves one connection, so its fields are per-connection state:

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

Other WebSocket servers can share the HTTP server: those attached before chanx, Nest's
gateways included, only see the paths a consumer does not serve. Clients are pinged every 20 seconds and dropped when they stop
answering, as uvicorn does for Python's chanx.

### Other runtimes

- **Bun, Deno, Cloudflare Workers, h3, Nitro, Nuxt:** `chanxHooks(chanx)` from
  `@chanx-js/server/crossws` gives [crossws](https://crossws.h3.dev) hooks for any of its
  adapters.
- **Hono, on any runtime:** `chanxHono(chanx, upgradeWebSocket)` from
  `@chanx-js/server/hono`, with the runtime's `upgradeWebSocket`:

  ```ts
  app.get('/ws/*', chanxHono(chanx, upgradeWebSocket));
  ```

- **Fastify:** `chanxFastify(chanx)` from `@chanx-js/server/fastify`, after registering
  `@fastify/websocket`; Fastify's hooks run before each upgrade.

The crossws and Hono adapters are tested on Node; they leave pings to the runtime.
Binary frames are refused with an error, as chanx refuses them. crossws drops
uWebSockets' binary flag, so every frame there looks binary: chanx cannot run on
crossws' uWebSockets adapter.

## Authentication

`authenticate` returns the user, or `false` to refuse. As in chanx, the socket is accepted
first and the client gets an `authentication` message, so a browser can show why. With
`rejectBeforeUpgrade: true`, `authenticate` runs before the upgrade and a refusal is an
HTTP status instead, for server-to-server clients.

## Groups and events

Connections join groups through a [channel layer](https://github.com/huynguyengl99/chanx-js/tree/main/packages/layers): in-memory by default, or
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

## Errors

Failures reach the client as chanx sends them; override any of them per consumer or
topic, as Python's `handle_validation_error`, `handle_message_handler_error` and
`handle_event_handler_error`:

```ts
consumer('/ws/chat', {
  name: 'chat',
  onValidationError: (issues, ctx) => ctx.send(Problem.create({ issues })),
  onHandlerError: (error, message, ctx) => report(error),
  onEventError: (error, event, ctx) => report(error),
});
```

Classes override the methods of the same names.

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

Or as a class, as chanx's sandbox writes topics. One instance serves one subscription,
and the class name names the layer group:

```ts
class RoomTopic extends Topic {
  static override pattern = 'room:{room_name}';
  static override passthrough = [RoomEvent];

  override authorize() {
    return this.params.room_name !== 'secret';
  }

  @On(Post, { output: Posted })
  async handle_post(m: MessageOf<typeof Post>) {
    await this.publish(RoomEvent.create(m.payload));
    return Posted.create(m.payload);
  }
}
```

Group names follow chanx (`RoomTopic.room-lobby`), so Python and Node publish to the
same subscribers.

## AsyncAPI

`chanx.asyncapi()` documents every consumer and topic as chanx's generator does, so
`@chanx-js/codegen` turns it into a typed client exactly as it would a Python server's:

```ts
import { asyncapiHandler } from '@chanx-js/server';
import { asyncapiMiddleware } from '@chanx-js/server/node';

// A docs page at /asyncapi, the document at /asyncapi.json and /asyncapi.yaml.
const asyncapi = asyncapiHandler(chanx, { title: 'Chat API' }); // a Fetch handler
honoApp.get('/asyncapi*', async (c, next) => (await asyncapi(c.req.raw)) ?? next());

expressApp.use(asyncapiMiddleware(chanx, { title: 'Chat API' })); // or on Node
```

Payload schemas come from [Standard JSON Schema](https://standardschema.dev/json-schema)
(Zod 4, ArkType, Valibot through `toStandardJsonSchema`). Give a payload a title, such as
Zod's `.meta({ title: 'ChatPayload' })`, to have it documented as a named component, as
pydantic models are.

## Validation

Payloads are validated by any [Standard Schema](https://standardschema.dev) library:
Zod, Valibot, ArkType and others. Validation errors reach the client in the shape
chanx's pydantic errors have.

## Testing

`@chanx-js/server/testing` connects to an app in-process, without a network:

```ts
import { connect } from '@chanx-js/server/testing';

const client = connect(chanx, '/ws/hub');
await client.ready;

const reply = await client.request({ action: 'ping' }); // the reply echoing its ref
client.sendMessage(Chat.create({ text: 'hi' }));
await client.subscribe('room:lobby');
const frames = await client.receiveAll(); // until the server goes quiet
expect(await client.receiveNothing()).toBe(true);
```

To assert on what was sent rather than on what a second client received, capture it.
Captures record without delivering unless given `{ suppress: false }`:

```ts
import { captureBroadcastEvents, captureTopicBroadcasts } from '@chanx-js/server/testing';

const events = captureBroadcastEvents(chanx, room); // chanx.broadcastEvent() calls
const posts = captureTopicBroadcasts(chanx, roomTopic); // ctx.publish() and chanx.publish()
await client.request(
  { action: 'post', payload: { body: 'hi' } },
  { topic: 'room:lobby' },
);
expect(posts.captured).toEqual([
  { topic: 'room:lobby', event: RoomEvent.create({ body: 'hi' }), seq: undefined },
]);
posts.restore();
```

## NestJS

[`@chanx-js/nestjs`](https://github.com/huynguyengl99/chanx-js/tree/main/packages/nestjs) serves these consumers and topics as injectable
gateways, with Nest's guards, interceptors, pipes and exception filters.
