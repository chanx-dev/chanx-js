# Server: getting started

`@chanx-js/server` is chanx for Node: typed WebSocket consumers that speak the same
protocol as Python's [chanx](https://github.com/huynguyengl99/chanx). `@chanx-js/client`
and generated clients work against either server, and the two can share one Redis.

Three packages make up the server side:

- **`@chanx-js/server`**: messages, consumers, topics, AsyncAPI, and adapters for Node,
  crossws and Hono.
- **`@chanx-js/layers`**: channel layers, so broadcasts reach every process. The Redis
  layer is wire-compatible with Python's.
- **`@chanx-js/nestjs`**: consumers and topics as injectable NestJS gateways.

::: tip Versions
Every chanx-js package's major version follows chanx's: 2.x speaks the chanx 2 protocol,
so any 2.x client works with any 2.x server, Node or Python.
:::

## Install

::: code-group

```bash [pnpm]
pnpm add @chanx-js/server ws zod
```

```bash [npm]
npm install @chanx-js/server ws zod
```

```bash [yarn]
yarn add @chanx-js/server ws zod
```

:::

`ws` serves sockets on Node's HTTP server. Any [Standard Schema](https://standardschema.dev)
library validates payloads; these pages use Zod.

## Define messages

A message is an `action` and a payload schema:

```ts
import { z } from 'zod';
import { defineMessage } from '@chanx-js/server';

const Chat = defineMessage('chat', z.object({ text: z.string() }));
const Notice = defineMessage('notice', z.object({ text: z.string() }));
```

`Chat.create({ text: 'hi' })` builds a typed `{ action: 'chat', payload: { text: 'hi' } }`.
`PingMessage` and `PongMessage` are built in.

## Write a consumer

A consumer serves one route and handles its messages:

```ts
import { PingMessage, PongMessage, consumer, createChanx } from '@chanx-js/server';

const chat = consumer('/ws/chat/{room}', { name: 'chat', emits: [Notice] })
  .on(PingMessage, { output: PongMessage }, () => PongMessage.create())
  .on(Chat, async (m, ctx) => {
    await ctx.send(Notice.create({ text: `${ctx.params.room}: ${m.payload.text}` }));
  });

export const chanx = createChanx({ consumers: [chat] });
```

The handler's message and `ctx` are typed: `m.payload.text` is a string,
`ctx.params.room` comes from the path, and `ctx.send` accepts only what the consumer
declares.

## Serve it

```ts
import { createServer } from 'node:http';
import { attachChanx } from '@chanx-js/server/node';

const server = createServer();
attachChanx(server, chanx);
server.listen(8000);
```

Connect a client to `ws://localhost:8000/ws/chat/lobby` and send
`{ "action": "ping" }`: the server answers `{ "action": "pong", "payload": null }`.

## Next

- [Consumers](./consumers): replies, state, authentication, groups and events.
- [Topics](./topics): many subscribable streams over one connection.
- [Serving](./serving): Express, Fastify, Koa, Bun, Deno, Hono and more.
- [AsyncAPI](./asyncapi): document the server and generate its client.
