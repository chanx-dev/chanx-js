---
# The comparison table needs the width the outline would take.
aside: false
---

# Why chanx-js?

Most WebSocket code in TypeScript starts on one of three paths: plain `ws`, Socket.IO, or
tRPC's subscriptions. Each is a good tool. chanx-js takes a different path: the server
publishes a contract, AsyncAPI, and both ends are typed from it.

## At a glance

|                          | chanx-js                               | Socket.IO                      | `ws`              | tRPC                         |
| ------------------------ | -------------------------------------- | ------------------------------ | ----------------- | ---------------------------- |
| Routing                  | A handler per action                   | A listener per event           | Write it yourself | A procedure per name         |
| Typed messages           | Generated from the server's schema     | Event maps you share by hand   | No                | Inferred from the router     |
| Runtime validation       | Any Standard Schema: Zod, Valibot, ... | Not built in                   | No                | Input parsers, such as Zod   |
| Request and reply        | `await request()`, typed per action    | `emitWithAck()`                | Write it yourself | Queries and mutations        |
| Groups across servers    | Redis layer, shared with Python chanx  | Rooms, with the Redis adapter  | Write it yourself | Write it yourself            |
| Many streams, one socket | Topics, restored after a reconnect     | Rooms and namespaces           | Write it yourself | A subscription per procedure |
| API documentation        | AsyncAPI 3, served by the server       | None                           | None              | None                         |
| Who can connect          | Any WebSocket client sending JSON      | Socket.IO clients              | Any WebSocket     | tRPC clients                 |
| Testing                  | In-process client, broadcast captures  | Run a server, connect a client | Same              | Call procedures directly     |

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
