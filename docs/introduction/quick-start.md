# Quick start

A chat server and a typed client talking to it, in one folder. You need Node 22 or
later.

## 1. Set up

```bash
mkdir chanx-quickstart && cd chanx-quickstart
npm init -y && npm pkg set type=module
npm install @chanx-js/server @chanx-js/client ws zod
npm install -D @chanx-js/codegen tsx
```

## 2. Write the server

```ts
// server.ts
import { createServer } from 'node:http';
import { z } from 'zod';
import {
  PingMessage,
  PongMessage,
  consumer,
  createChanx,
  defineMessage,
} from '@chanx-js/server';
import { asyncapiMiddleware, attachChanx } from '@chanx-js/server/node';

const Chat = defineMessage('chat', z.object({ text: z.string() }));
const Notice = defineMessage('notice', z.object({ text: z.string() }));

const chat = consumer('/ws/chat/{room}', {
  name: 'chat',
  emits: [Notice],
  groups: (conn) => [`room.${conn.params.room}`],
})
  .on(PingMessage, { output: PongMessage }, () => PongMessage.create())
  .on(Chat, (m, ctx) => ctx.broadcast(Notice.create({ text: m.payload.text })));

const chanx = createChanx({ consumers: [chat] });
const server = createServer(asyncapiMiddleware(chanx));
attachChanx(server, chanx);
server.listen(8000);
```

What each part does:

- **`defineMessage`** pairs an action with a payload schema. Any
  [Standard Schema](https://standardschema.dev) library works; this uses Zod.
- **`consumer`** serves one route. `{room}` is a path param, typed from the path, so
  `conn.params.room` is a `string`.
- **`.on(Message, handler)`** routes a message by its action. The payload is validated
  before the handler runs, and a bad one gets an `error` frame back.
- **`output`** declares the reply, and **`emits`** what the consumer sends otherwise.
  Both are checked by TypeScript and documented.
- **`groups`** puts each connection in its room, and **`ctx.broadcast`** sends to
  everyone in it.

Start it:

```bash
npx tsx server.ts
```

Open [localhost:8000/asyncapi](http://localhost:8000/asyncapi) to see the API it
documents.

## 3. Generate the client

With the server running, in a second terminal:

```bash
npx chanx-codegen http://localhost:8000/asyncapi.json
```

This writes `src/generated`: a type per message, and a `chat` channel that knows its
address and every message it can send and receive. Run it again whenever the server's
messages change.

## 4. Write the client

```ts
// client.ts
import { createClient } from '@chanx-js/client';

import { chat } from './src/generated/index.js';

const client = createClient({ baseUrl: 'ws://localhost:8000' });
const connection = client.connect(chat, { params: { room: 'lobby' } });

connection.on('notice', (message) => console.log(message.payload.text));
await connection.request({ action: 'ping' }); // resolves with the pong
connection.send({ action: 'chat', payload: { text: 'hello' } });
```

```bash
npx tsx client.ts
```

It prints `hello`: the server broadcast the chat message back to everyone in `lobby`,
this client included. Press Ctrl+C to stop it.

Try breaking it. Change `text` to `txt`, or `'notice'` to `'notic'`: your editor
underlines both, because the client's types come from the server's schema.

## Next

- [Build a chat server](/tutorials/chat-server): authentication, history, presence and
  tests.
- [Build a chat UI in React](/tutorials/chat-ui) on top of it.
- Already have a framework? See [server integrations](/server/integrations/) and
  [client integrations](/client/integrations/react).
