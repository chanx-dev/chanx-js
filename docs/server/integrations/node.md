# Node, Express, Koa

`attachChanx` from `@chanx-js/server/node` serves an app on any Node HTTP server,
through [`ws`](https://github.com/websockets/ws):

```bash
npm install @chanx-js/server ws
```

## Node's `http`

```ts
import { createServer } from 'node:http';
import {
  asyncapiMiddleware,
  attachChanx,
} from '@chanx-js/server/node';

import { chanx } from './app.js';

// AsyncAPI docs at /asyncapi
const server = createServer(asyncapiMiddleware(chanx));
attachChanx(server, chanx);
server.listen(8000);
```

`asyncapiMiddleware` answers its own paths and 404s the rest. Leave it out if you do not
want the docs served.

## Express

Hand Express to the HTTP server, then attach chanx to that server, not to the Express
app:

```ts
import { createServer } from 'node:http';
import express from 'express';
import {
  asyncapiMiddleware,
  attachChanx,
} from '@chanx-js/server/node';

const app = express();
app.use(asyncapiMiddleware(chanx));
app.get('/health', (_req, res) => void res.send('ok'));

const server = createServer(app);
attachChanx(server, chanx);
server.listen(8000);
```

## Koa

The same, with the app's `callback()`:

```ts
const app = new Koa();
const server = createServer(app.callback());
attachChanx(server, chanx);
server.listen(8000);
```

## Options

```ts
const attachment = attachChanx(server, chanx, {
  pingInterval: 20_000, // the default; 0 turns pings off
  maxBufferedAmount: 16 * 1024 * 1024, // the default
});
```

- Each client is pinged every `pingInterval` and dropped when it stops answering.
- A client that stops reading is dropped once more than `maxBufferedAmount` bytes wait
  unsent for it, with a warning through the app's logger, so it cannot hold the server's
  memory. The limit counts bursts too: keep it above the most one handler sends at once.
  `@chanx-js/client` reconnects and resubscribes after a drop.
- `attachment.close()` stops serving and closes every socket with 1001 (going away). Call
  it on shutdown, before `server.close()`.

## Sharing the server with other WebSockets

Other WebSocket servers (Socket.IO, Vite's HMR, Nest gateways) can share the HTTP
server. Those attached before chanx never see the paths a consumer serves, even one that
refuses every path but its own, as `ws` given the server does. Attach any added later
before chanx, or with `noServer`.
