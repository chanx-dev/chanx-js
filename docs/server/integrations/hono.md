# Hono

`chanxHono` from `@chanx-js/server/hono` serves chanx from a Hono route, on any runtime
Hono runs on. It takes that runtime's `upgradeWebSocket`.

::: code-group

```ts [Bun]
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { asyncapiHandler } from '@chanx-js/server';
import { chanxHono } from '@chanx-js/server/hono';

const app = new Hono();
const asyncapi = asyncapiHandler(chanx);

app.get('/asyncapi*', async (c, next) => (await asyncapi(c.req.raw)) ?? next());
app.get('/ws/*', chanxHono(chanx, upgradeWebSocket));

export default { port: 8000, fetch: app.fetch, websocket };
```

```ts [Deno]
import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/deno';
import { chanxHono } from '@chanx-js/server/hono';

const app = new Hono();
app.get('/ws/*', chanxHono(chanx, upgradeWebSocket));

Deno.serve({ port: 8000 }, app.fetch);
```

```ts [Node]
import { serve, upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { chanxHono } from '@chanx-js/server/hono';

const app = new Hono();
app.get('/ws/*', chanxHono(chanx, upgradeWebSocket));

serve({
  fetch: app.fetch,
  port: 8000,
  websocket: { server: new WebSocketServer({ noServer: true }) },
});
```

```ts [Cloudflare Workers]
import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/cloudflare-workers';
import { chanxHono } from '@chanx-js/server/hono';

const app = new Hono();
app.get('/ws/*', chanxHono(chanx, upgradeWebSocket));

export default app;
```

:::

Mount it on a wildcard that covers your consumers' paths, such as `/ws/*`. Requests
for paths no consumer serves go on to the next handler, so Hono's middleware, auth
included, runs before the upgrade.

- Hono leaves pings to the runtime.
- On `@hono/node-server`, a [refused upgrade](/server/consumers#refusing-before-the-upgrade)
  carries its status but no body.
- Cloudflare Workers are not tested yet.
