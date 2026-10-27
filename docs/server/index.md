# Server: getting started

Write a WebSocket server where every message has a schema. Each action gets a typed,
validated handler instead of an if/else branch; rooms broadcast across processes; and the
server documents itself as AsyncAPI, so its clients are generated, not hand-typed. This
page takes you from install to a running server in a few minutes; for how it compares
with Socket.IO or `ws`, see [Why chanx-js?](/introduction/why).

It speaks the protocol of Python's [chanx](https://github.com/chanx-dev/chanx), so
the same clients work against either, and the two can share one Redis.

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

::: tip Plain JavaScript
The builder API needs no TypeScript syntax, so the files on this page run unchanged
as `.js`, with handlers still typed in your editor or under `checkJs`. Only the
[class API](./classes) needs a compiler, for its decorators.
:::

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
const Notice = defineMessage(
  'notice',
  z.object({ text: z.string() }),
);

const chat = consumer('/ws/chat/{room}', {
  name: 'chat',
  emits: [Notice],
})
  .on(PingMessage, { output: PongMessage }, () =>
    PongMessage.create(),
  )
  .on(Chat, async (m, ctx) => {
    await ctx.send(
      Notice.create({
        text: `${ctx.params.room}: ${m.payload.text}`,
      }),
    );
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
import {
  asyncapiMiddleware,
  attachChanx,
} from '@chanx-js/server/node';

import { chanx } from './chanx.js';

// AsyncAPI at /asyncapi
const server = createServer(asyncapiMiddleware(chanx));
attachChanx(server, chanx);
server.listen(8000);
```

```ts [Express]
// server.ts, after: npm install express ws
import { createServer } from 'node:http';
import express from 'express';
import {
  asyncapiMiddleware,
  attachChanx,
} from '@chanx-js/server/node';

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
app.get(
  '/asyncapi*',
  async (c, next) => (await asyncapi(c.req.raw)) ?? next(),
);
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
  async (request, info) =>
    (await asyncapi(request)) ?? ws.handleUpgrade(request, info),
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
