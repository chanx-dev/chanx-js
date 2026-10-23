# Serving

An app from `createChanx()` knows nothing about sockets: an adapter hands it each
connection. Pick the one for your server or runtime.

## Node: `http`, Express, Fastify, Koa

`attachChanx` from `@chanx-js/server/node` serves an app on any Node HTTP server,
through [`ws`](https://github.com/websockets/ws) (a peer dependency):

```ts
import { createServer } from 'node:http';
import { attachChanx } from '@chanx-js/server/node';

const server = createServer(expressApp); // or a Koa app's callback()
const attachment = attachChanx(server, chanx);
server.listen(8000);
```

With Fastify, attach to the server it creates: `attachChanx(fastify.server, chanx)`.

- Other WebSocket servers (Socket.IO, Vite's HMR, Nest gateways) can share the HTTP
  server. Those attached before chanx never see the paths a consumer serves, even one
  that refuses every path but its own, as `ws` given the server does. Attach any added
  later before chanx, or with `noServer`.
- Each client is pinged every 20 seconds and dropped when it stops answering. Set
  `pingInterval` to change it, or `0` to turn it off.
- `attachment.close()` stops serving and closes every socket with 1001 (going away).

## Bun, Deno, Cloudflare Workers, h3, Nitro, Nuxt

`chanxHooks(chanx)` from `@chanx-js/server/crossws` gives
[crossws](https://crossws.h3.dev) hooks, for any of its adapters:

```ts
import { defineHooks } from 'crossws';
import { chanxHooks } from '@chanx-js/server/crossws';

export default defineHooks(chanxHooks(chanx));
```

An upgrade for a path no consumer serves is refused with 404.

## Hono, on any runtime

`chanxHono` from `@chanx-js/server/hono` takes the runtime's `upgradeWebSocket`, from
`hono/bun`, `hono/deno`, `hono/cloudflare-workers` or `@hono/node-ws`:

```ts
import { upgradeWebSocket } from 'hono/bun';
import { chanxHono } from '@chanx-js/server/hono';

app.get('/ws/*', chanxHono(chanx, upgradeWebSocket));
```

Requests for paths no consumer serves go on to the next handler, so Hono's middleware,
auth included, runs before the upgrade.

## NestJS

Use [`@chanx-js/nestjs`](./nestjs) for injectable gateways. For a socket outside Nest's
DI, `attachChanx(app.getHttpServer(), chanx)` works too.

## What each adapter does the same

- Binary frames are answered with an `error` (`json_invalid`), as chanx answers them;
  the connection stays open. crossws's uWebSockets adapter drops the binary flag, so
  every frame there looks binary: chanx cannot run on it.
- A path no consumer serves is refused.
- The crossws and Hono adapters leave pings to the runtime.

::: info Tested on
The test suite runs every adapter on Node over real sockets: Node's `http` with `ws`,
crossws's Node adapter, and Hono on `@hono/node-server`. Other runtimes and
frameworks are not tested yet.
:::
