# Fastify

`chanxFastify` from `@chanx-js/server/fastify` registers a route per consumer path,
through [`@fastify/websocket`](https://github.com/fastify/fastify-websocket):

```bash
npm install @chanx-js/server @fastify/websocket
```

```ts
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { chanxFastify } from '@chanx-js/server/fastify';

import { chanx } from './app.js';

const app = Fastify();
await app.register(websocket);
await app.register(chanxFastify(chanx));

app.get('/asyncapi.json', () => chanx.asyncapi());

await app.listen({ port: 8000 });
```

- Register `@fastify/websocket` first; `chanxFastify` throws if it is missing.
- Register it without a prefix: the routes are the consumers' own paths.
- `chanxFastify(chanx, { pingInterval, maxBufferedAmount })` takes the same options as
  the [Node adapter](./node#options), with the same defaults.
- `@fastify/websocket` closes the sockets when Fastify closes; its `preClose` option sets
  how.

## Refusing an upgrade in a hook

Fastify's hooks run before each upgrade, so an `onRequest` hook or an auth plugin can
refuse one with an HTTP status, which a client sees before any socket opens:

```ts
app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/ws/admin') && !isAdmin(request)) {
    await reply.code(403).send({ detail: 'Admins only' });
  }
});
```

For refusals that belong to the consumer, use its own
[`authenticate`](/server/consumers#authentication), which works the same on every
adapter.
