# Server integrations

An app from `createChanx()` knows nothing about sockets: an adapter hands it each
connection. Your consumers stay the same whichever adapter serves them, so you can
change servers or runtimes without touching them.

| You run                                | Adapter                    | Page                               |
| -------------------------------------- | -------------------------- | ---------------------------------- |
| Node's `http`, Express, Koa, Connect   | `@chanx-js/server/node`    | [Node, Express, Koa](./node)       |
| Fastify                                | `@chanx-js/server/fastify` | [Fastify](./fastify)               |
| Hono, on Node, Bun, Deno or Workers    | `@chanx-js/server/hono`    | [Hono](./hono)                     |
| Bun, Deno, h3, Nitro, Nuxt, and others | `@chanx-js/server/crossws` | [Bun, Deno and crossws](./crossws) |
| NestJS                                 | `@chanx-js/nestjs`         | [NestJS](./nestjs)                 |

Each adapter is its own entry point, and its framework is an optional peer dependency:
install only the one you use.

## What every adapter does the same

- A path no consumer serves is refused, and so, with an HTTP status, is an
  unauthenticated upgrade to a consumer with
  [`rejectBeforeUpgrade`](/server/consumers#refusing-before-the-upgrade).
- Binary frames are answered with an `error` (`json_invalid`), as chanx answers them;
  the connection stays open. crossws's uWebSockets adapter drops the binary flag, so
  every frame there looks binary: chanx cannot run on it.
- The Node and Fastify adapters ping each client and drop the ones that stop answering
  or stop reading. The crossws and Hono adapters leave pings to the runtime.

::: info Tested on
The full suites, `@chanx-js/client` end to end included, run every adapter over real
sockets on Node: `/node` on plain `http`, Express and Koa; Fastify; crossws on its Node
adapter and under h3; Hono on `@hono/node-server`. CI also runs the built packages on
Bun and Deno, through each runtime's crossws and Hono adapters. Cloudflare Workers is
not tested yet.
:::
