# Server: getting started

`@chanx-js/server` is chanx for Node: typed WebSocket consumers that speak the same
protocol as Python's [chanx](https://github.com/huynguyengl99/chanx). `@chanx-js/client`
and generated clients work against either server, and the two can share one Redis.

Three packages make up the server side:

- **`@chanx-js/server`**: messages, consumers, topics, AsyncAPI, testing helpers, and
  adapters for Node, Fastify, Hono and crossws.
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
pnpm add @chanx-js/server zod
```

```bash [npm]
npm install @chanx-js/server zod
```

```bash [yarn]
yarn add @chanx-js/server zod
```

:::

Each server below adds its own packages. Any [Standard Schema](https://standardschema.dev)
library validates payloads; these pages use Zod.

## Define messages and a consumer

Put the app in `chanx.ts`, apart from the server, so tests and any server can share it:

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

- **`defineMessage`** pairs an action with a payload schema. `Chat.create({ text: 'hi' })`
  builds a typed `{ action: 'chat', payload: { text: 'hi' } }`. `PingMessage` and
  `PongMessage` are built in.
- **`consumer`** serves one route and routes each message to its handler.
- The handler's message and `ctx` are typed: `m.payload.text` is a string,
  `ctx.params.room` comes from the path, and `ctx.send` accepts only what the consumer
  declares in `emits`.

## Serve it

Pick your server. Each tab is a complete `server.ts`:

::: code-group

```ts [Node]
// server.ts, after: npm install ws
import { createServer } from 'node:http';
import { asyncapiMiddleware, attachChanx } from '@chanx-js/server/node';

import { chanx } from './chanx.js';

const server = createServer(asyncapiMiddleware(chanx)); // AsyncAPI at /asyncapi
attachChanx(server, chanx);
server.listen(8000);
```

```ts [Express]
// server.ts, after: npm install express ws
import { createServer } from 'node:http';
import express from 'express';
import { asyncapiMiddleware, attachChanx } from '@chanx-js/server/node';

import { chanx } from './chanx.js';

const app = express();
app.use(asyncapiMiddleware(chanx)); // AsyncAPI at /asyncapi

const server = createServer(app);
attachChanx(server, chanx);
server.listen(8000);
```

```ts [Fastify]
// server.ts, after: npm install fastify @fastify/websocket
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { chanxFastify } from '@chanx-js/server/fastify';

import { chanx } from './chanx.js';

const app = Fastify();
await app.register(websocket);
await app.register(chanxFastify(chanx));
app.get('/asyncapi.json', () => chanx.asyncapi());

await app.listen({ port: 8000 });
```

```ts [Hono]
// server.ts, after: npm install hono @hono/node-server ws
import { serve, upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { asyncapiHandler } from '@chanx-js/server';
import { chanxHono } from '@chanx-js/server/hono';

import { chanx } from './chanx.js';

const asyncapi = asyncapiHandler(chanx);
const app = new Hono();
app.get('/asyncapi*', async (c, next) => (await asyncapi(c.req.raw)) ?? next());
app.get('/ws/*', chanxHono(chanx, upgradeWebSocket));

serve({
  fetch: app.fetch,
  port: 8000,
  websocket: { server: new WebSocketServer({ noServer: true }) },
});
```

```ts [Bun]
// server.ts, after: npm install crossws
import bunAdapter from 'crossws/adapters/bun';
import { asyncapiHandler } from '@chanx-js/server';
import { chanxHooks } from '@chanx-js/server/crossws';

import { chanx } from './chanx.ts';

const ws = bunAdapter({ hooks: chanxHooks(chanx) });
const asyncapi = asyncapiHandler(chanx);

Bun.serve({
  port: 8000,
  websocket: ws.websocket,
  fetch: async (request, server) =>
    (await asyncapi(request)) ?? ws.handleUpgrade(request, server),
});
```

```ts [Deno]
// server.ts, after: npm install crossws
import denoAdapter from 'crossws/adapters/deno';
import { asyncapiHandler } from '@chanx-js/server';
import { chanxHooks } from '@chanx-js/server/crossws';

import { chanx } from './chanx.ts';

const ws = denoAdapter({ hooks: chanxHooks(chanx) });
const asyncapi = asyncapiHandler(chanx);

Deno.serve(
  { port: 8000 },
  async (request, info) => (await asyncapi(request)) ?? ws.handleUpgrade(request, info),
);
```

:::

Run it with `npx tsx server.ts`, `bun server.ts` or `deno run -A server.ts`. Bun and Deno
import `./chanx.ts` by its real name. Every tab serves the AsyncAPI document at
`/asyncapi.json`, which the [client](/client/) is generated from.

::: tip NestJS
Nest defines consumers as injectable classes instead. See
[NestJS](/server/integrations/nestjs).
:::

Connect any WebSocket client to `ws://localhost:8000/ws/chat/lobby` and send
`{ "action": "ping" }`: the server answers `{ "action": "pong", "payload": null }`.

## Next

- [Build a chat server](/tutorials/chat-server): the same pieces, step by step, with
  authentication, groups and tests.
- [Consumers](./consumers): replies, state, authentication, groups and events.
- [Topics](./topics): many subscribable streams over one connection.
- [Integrations](/server/integrations/): Express, Fastify, Koa, Hono, Bun, Deno and
  NestJS.
- [AsyncAPI](./asyncapi): document the server and generate its client.
