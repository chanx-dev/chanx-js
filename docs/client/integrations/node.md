# Node services and scripts

The client needs no framework: the runtime is the API. That makes it a client for other
servers too, such as a worker feeding a dashboard, a bot in a chat room, a backend that
talks to another team's chanx server, or a script that checks a deployment.

It runs on Node 22 and later, Bun and Deno, which all ship a global `WebSocket`.

## Connect, ask, listen

```ts
import { createClient } from '@chanx-js/client';

import { chat } from './generated/index.js';

const client = createClient({ baseUrl: 'ws://localhost:8000' });
const lobby = client.connect(chat, {
  params: { room: 'lobby' },
  queryParams: { name: 'bot' },
});

await lobby.ready(); // open, or throw once it gives up
const pong = await lobby.request({ action: 'ping' }); // the reply, typed PongMessage
const first = await lobby.once('said', { timeout: 5000 }); // the next `said`

for await (const message of lobby) {
  if (message.action === 'said' && message.payload.text === '!time') {
    lobby.send({ action: 'say', payload: { text: new Date().toISOString() } });
  }
}
```

- Sends made before the socket opens are queued and flushed on open, so `ready()` is
  only needed to fail fast.
- The `for await` loop ends when the connection closes, or once the socket gives up
  reconnecting. `lobby.stream({ limit, signal })` is the configurable form: it holds at
  most `limit` messages (default 1024) while the loop body is busy, dropping the oldest,
  and stops when the signal aborts.
- Topic handles have the same `once`, `stream` and `for await`.

## Authenticate as a service

A browser can only put credentials in the URL, but a service can send headers. Node's
built-in `WebSocket` cannot set them, so pass a `socketFactory` that uses
[`ws`](https://github.com/websockets/ws):

```ts
import WebSocket from 'ws';

const client = createClient({
  baseUrl: 'wss://api.example.com',
  socketFactory: (url, protocols) =>
    new WebSocket(url, protocols, {
      headers: { authorization: `Bearer ${process.env.INGEST_KEY}` },
    }) as never,
});
```

On a chanx-js server, read the header in `authenticate`. With `rejectBeforeUpgrade`, a
wrong key is refused with 401 before any socket opens, which suits a service: no
browser needs to read why.

```ts
const ingest = consumer('/ws/ingest', {
  name: 'ingest',
  rejectBeforeUpgrade: true,
  authenticate: ({ headers }) =>
    headers.get('authorization') === `Bearer ${process.env.INGEST_KEY}`
      ? { service: 'sensors' }
      : false,
}).on(Reading, { output: Ack }, () => Ack.create());
```

`ws` also serves Node 20, which has no global `WebSocket`: pass the same factory without
the headers.

## Retry, or fail fast

A connection retries 10 times by default, backing off from one second to 30, so about
three minutes pass before it gives up. That suits a long-running service riding out a
deploy. A script or a health check usually wants an answer sooner:

```ts
const connection = client.connect(ingest, { reconnectAttempts: 0 });
await connection.ready({ timeout: 5000 });
```

`ready()` rejects once the socket gives up, and with `timeout`, after that long.
`shouldReconnect(event)` decides per close, such as giving up on a close code your
server uses for "go away".

## Stop cleanly

A script should close what it opened, or the process stays alive:

```ts
connection.close();
client.closeAll(); // every socket this client opened
```

## Plain JavaScript

Generate JavaScript output and import it directly:

```bash
npx @chanx-js/codegen <schema> -o src/generated --emit js
```

```js
// @ts-check
import { createClient } from '@chanx-js/client';

import { chat } from './generated/index.js';
```

The emitted `.d.ts` files give a JavaScript project the same narrowing and checks as a
TypeScript one, in the editor or under `checkJs`.
