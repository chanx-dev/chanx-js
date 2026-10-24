# Bun, Deno and crossws

`chanxHooks(chanx)` from `@chanx-js/server/crossws` gives
[crossws](https://crossws.h3.dev) hooks, which serve chanx on any runtime crossws
supports: Bun, Deno, Node, Cloudflare and, through h3, Nitro and Nuxt.

```bash
npm install @chanx-js/server crossws
```

::: code-group

```ts [Bun]
import bunAdapter from 'crossws/adapters/bun';
import { chanxHooks } from '@chanx-js/server/crossws';

const ws = bunAdapter({ hooks: chanxHooks(chanx) });

Bun.serve({
  port: 8000,
  websocket: ws.websocket,
  fetch: (request, server) => ws.handleUpgrade(request, server),
});
```

```ts [Deno]
import denoAdapter from 'crossws/adapters/deno';
import { chanxHooks } from '@chanx-js/server/crossws';

const ws = denoAdapter({ hooks: chanxHooks(chanx) });

Deno.serve({ port: 8000 }, (request, info) => ws.handleUpgrade(request, info));
```

```ts [h3]
import { H3, defineWebSocketHandler } from 'h3';
import { serve } from 'crossws/server';
import { chanxHooks } from '@chanx-js/server/crossws';

const app = new H3();
app.get('/ws/**', defineWebSocketHandler(chanxHooks(chanx)));

// `websocket: {}` takes the hooks h3 attaches to its response.
serve({ fetch: app.fetch, port: 8000, websocket: {} });
```

:::

In a Nitro or Nuxt app, export the hooks from a WebSocket route handler with
`defineWebSocketHandler(chanxHooks(chanx))`.

- An upgrade for a path no consumer serves is refused with 404.
- The runtime handles pings.
- Serve the AsyncAPI docs with [`asyncapiHandler`](/server/asyncapi#serve-it), a Fetch
  handler.
- crossws's uWebSockets adapter cannot run chanx: it drops the binary flag, so every
  frame looks binary.
