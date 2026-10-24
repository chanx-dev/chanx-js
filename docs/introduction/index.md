# What is chanx-js?

chanx-js is a WebSocket framework for TypeScript, on the server and the client. You
declare your messages once, as schemas. The server routes each incoming message to its
handler, validates it, and documents the whole API as AsyncAPI. The client is generated
from that document, so every message you send and receive is typed, in a browser, a
framework app or another service.

## How the pieces fit

<div class="flow">
  <div class="flow-step"><strong>@chanx&#8209;js/<wbr>server</strong><span>messages and consumers</span></div>
  <div class="flow-arrow" aria-hidden="true">→</div>
  <div class="flow-step"><strong>AsyncAPI 3</strong><span>served at /asyncapi.json</span></div>
  <div class="flow-arrow" aria-hidden="true">→</div>
  <div class="flow-step"><strong>@chanx&#8209;js/<wbr>codegen</strong><span>typed channels</span></div>
  <div class="flow-arrow" aria-hidden="true">→</div>
  <div class="flow-step"><strong>@chanx&#8209;js/<wbr>client</strong><span>browser, React, Vue, Svelte, Solid, Node</span></div>
</div>

Behind the server, `@chanx-js/layers` carries groups and broadcasts between processes,
and `@chanx-js/nestjs` hosts consumers as NestJS gateways.

| Package             | Role                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `@chanx-js/server`  | Consumers and topics: routing, validation, groups, AsyncAPI, test helpers. |
| `@chanx-js/client`  | The client runtime, with React, Vue, Svelte and Solid bindings.            |
| `@chanx-js/codegen` | Turns any chanx AsyncAPI document into typed channel descriptors.          |
| `@chanx-js/layers`  | Carries groups and broadcasts between processes, over Redis.               |
| `@chanx-js/nestjs`  | Consumers and topics as NestJS gateways, with DI, guards and pipes.        |

You can use any part alone. The client and codegen work against a Python chanx server
with no Node server at all; the server works with any WebSocket client that sends JSON.

## The protocol

Every frame is a JSON object with an `action` and a `payload`:

```json
{ "action": "say", "payload": { "text": "hello" } }
```

A few optional fields route it:

- **`ref`**: a client sets it on a request, and the reply carries it back. This is how
  `await connection.request(...)` finds its answer on a busy socket.
- **`topic`**: names the topic a frame belongs to, such as `room:lobby`, so one socket
  carries many subscriptions.
- **`seq`**: a number a publisher may stamp on topic messages, for gap detection.

Validation errors come back as an `error` frame in the shape of pydantic's errors
(`type`, `loc`, `msg`), so a client can branch on them whichever server answered.

This is the [chanx](https://github.com/huynguyengl99/chanx) protocol, the one Python's
chanx speaks on Django Channels and FastAPI. That is why the pieces mix: a chanx-js client
talks to a Python server, and Node and Python servers share one Redis.

## What it does not do

- **No binary frames.** Messages are JSON. Send files over HTTP and their URLs over the
  socket.
- **No fallback transports.** It is WebSockets only, without Socket.IO's long polling.
- **No delivery guarantees.** Like the WebSocket underneath, a message sent while a
  client is disconnected is gone. Send state on connect, as the
  [chat tutorial](/tutorials/chat-server) does with its history, or use `seq` to detect
  gaps.

## Versions

Every package's major version follows chanx's: 2.x speaks the chanx 2 protocol, so any
2.x client works with any 2.x server, Node or Python. Within a major, each package has its
own minor and patch releases; see the [changelog](/reference/changelog).

## Next

- [Quick start](./quick-start): a server and a typed client, running in five minutes.
- [Build a chat server](/tutorials/chat-server), then
  [its React UI](/tutorials/chat-ui), step by step.
