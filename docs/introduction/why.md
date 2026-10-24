---
# The comparison table needs the width the outline would take.
aside: false
---

# Why chanx-js?

WebSocket code in TypeScript usually starts on one of three paths: plain `ws`, Socket.IO, or
tRPC's subscriptions. Each is a good tool. chanx-js takes a different path: the server
publishes a contract, AsyncAPI, and both ends are typed from it.

## At a glance

|                      | chanx-js                                                                                              | Socket.IO                                                                                                 | `ws`                           | tRPC                             |
| -------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------- |
| Routing              | A handler per action                                                                                  | A listener per event                                                                                      | Parse, then if/else on a field | A procedure per name             |
| Typed messages       | Generated from the server's schema                                                                    | Event maps you share by hand                                                                              | No                             | Inferred from the router         |
| Runtime validation   | Any Standard Schema: Zod, Valibot, ...                                                                | Not built in                                                                                              | No                             | Input parsers, such as Zod       |
| Request and reply    | `await request()`, typed per action                                                                   | `emitWithAck()`                                                                                           | Write it yourself              | Queries and mutations            |
| Groups (server-side) | Joined on the server; any process, workers included, broadcasts over Redis                            | Rooms, joined on the server; across servers with the Redis adapter, from other processes with its emitter | Write it yourself              | Write it yourself                |
| Multiplexing         | Topics: many streams on one socket, each subscribed by name, authorized and resumed after a reconnect | Namespaces share one connection; joining a room needs an event of your own                                | One stream per socket          | Many subscriptions on one socket |
| API documentation    | AsyncAPI 3, served by the server                                                                      | None                                                                                                      | None                           | None                             |
| Who can connect      | Any WebSocket client sending JSON                                                                     | Socket.IO clients, in several languages                                                                   | Any WebSocket                  | tRPC clients                     |
| Testing              | In-process client, broadcast captures                                                                 | Run a server, connect a client                                                                            | Same                           | Call procedures directly         |

## Compared with Socket.IO

Socket.IO gives you events, rooms and acknowledgements, and its Redis adapter carries
rooms across servers: much of what chanx-js does. The differences:

- **Types are a contract, not a convention.** Socket.IO's typed event maps are
  interfaces you write once and import on both sides; nothing checks them at runtime,
  and they stop at the TypeScript boundary. A chanx-js server validates every message it
  receives against its schema, and the client's types are generated from what the
  server documents.
- **The wire is plain WebSocket and JSON.** Socket.IO speaks its own protocol, so the
  other end needs a Socket.IO client. Anything that speaks WebSocket can talk to a
  chanx-js server.
- **The API is documented.** The AsyncAPI page shows every message a consumer takes and
  sends, for the team on the other end.
- **Socket.IO replays what a client missed.** Its connection state recovery restores a
  socket's rooms and missed packets after a short disconnection, two minutes by default.
  chanx-js resubscribes but does not replay: send state on (re)subscribe, as topics'
  `onSubscribe` does, or number messages with `seq` to spot gaps.

### Rooms and topics

A Socket.IO room is joined on the server, so a client that wants one sends an event you
define, and your handler checks access and joins it. A chanx topic is subscribed to from
the client: the protocol carries the request, the topic's `authorize` decides, and the
client subscribes again after every reconnect.

::: code-group

```ts [Socket.IO]
// server
io.on('connection', (socket) => {
  socket.on('join', (room: string) => {
    if (canJoin(socket.data.user, room)) socket.join(room);
  });
});
io.to('room:lobby').emit('posted', { body: 'hi' });

// client: ask again after every reconnect
socket.on('connect', () => socket.emit('join', 'room:lobby'));
socket.on('posted', (post) => render(post));
```

```ts [chanx-js]
// server
const roomTopic = topic('room:{name}', {
  authorize: ({ params, conn }) => canJoin(conn.user, params.name),
}).passthrough(Posted);

const hub = consumer('/ws/hub', {
  name: 'hub',
  topics: [roomTopic],
});

await chanx.publish(
  roomTopic,
  roomTopic.with({ name: 'lobby' }),
  Posted.create({ body: 'hi' }),
);

// client, with `hub` generated from the server's schema
const connection = client.connect(hub);
const room = connection.topic(
  hub.topics.roomTopic.with({ name: 'lobby' }),
);
await room.subscribe(); // and again by itself after every reconnect
room.on('posted', (message) => render(message.payload));
```

:::

Topics also share one subscription between every component on a socket that wants the
same topic, and a refused subscribe rejects with an `unauthorized` error. Groups, the
server-side half, work like rooms, and a worker or another process can broadcast to them
with `chanx.broadcastEvent()`. See [Topics](/server/topics) and
[Consumers](/server/consumers#groups-and-broadcasts).

## Compared with `ws`

`ws` is a fast, minimal WebSocket server, and chanx-js runs on it under Node. On its own,
it hands you strings: routing, validation, rooms, request matching, reconnection and
heartbeats are yours to write, on both ends. chanx-js is that layer, written once.

## Compared with tRPC

tRPC types a TypeScript client by importing the server's router type, which is
excellent within one TypeScript codebase. chanx-js publishes a schema instead, so a
client needs no access to the server's code: a separate repository, another team, or a
Python service. It is also built for push-heavy traffic, with groups that broadcast to
many connections and topics that multiplex on one socket, where tRPC is built around
procedures.

## Compared with NestJS gateways

`@nestjs/websockets` routes messages to decorated handlers over Socket.IO or `ws`, with
Nest's pipes, guards and DI. [`@chanx-js/nestjs`](/server/integrations/nestjs) keeps
those, and adds what gateways leave out: the chanx protocol, typed request and reply,
topics, AsyncAPI, and a generated client. The two can run side by side in one app.

## When to choose something else

- **You need long-polling fallback**, for networks that block WebSockets: Socket.IO
  falls back to HTTP; chanx-js is WebSockets only.
- **Your client and server share one TypeScript codebase, and most calls are
  request and reply:** tRPC's inferred types need no generation step.
- **You need binary frames or the last bit of throughput:** `ws` alone, or a binary
  protocol over it. chanx-js messages are JSON.
- **You already run Python chanx:** keep it. chanx-js clients work with it as they
  are, and you can add Node consumers [alongside it](/advanced/python).
