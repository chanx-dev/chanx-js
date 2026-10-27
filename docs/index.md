---
layout: home

hero:
  text: Type-safe WebSockets for JavaScript and TypeScript, end to end.
  tagline: Declare your messages once. chanx-js routes, validates, broadcasts and documents them on the server, and generates a typed client for the browser, your framework or another Node service.
  actions:
    - theme: brand
      text: Build a server
      link: /server/
    - theme: alt
      text: Connect a client
      link: /client/
    - theme: alt
      text: GitHub
      link: https://github.com/chanx-dev/chanx-js

features:
  - title: Handlers, not if/else
    details: 'Each action gets a typed handler. Payloads are validated by Zod, Valibot, ArkType or any Standard Schema before your code sees them.'
  - title: Typed on both ends
    details: 'The server publishes AsyncAPI 3; codegen turns it into a typed client. Sending a message the server does not accept is a compile error, or an editor error in plain JavaScript.'
  - title: Groups and topics
    details: 'Broadcast to groups across processes over Redis. Clients subscribe to many topics over one socket, restored after a reconnect.'
  - title: Requests that await
    details: "await connection.request(...) resolves with the reply to that message, typed from the server's schema and matched by ref, even on a socket shared by many components."
  - title: Runs where you do
    details: 'Serve from Node, Fastify, Hono, NestJS, Bun or Deno. Connect from React, Vue, Svelte, Solid, plain JavaScript or a Node service.'
  - title: Compatible with Python chanx
    details: 'Same protocol as chanx on Django Channels and FastAPI: one client for either server, and one Redis shared by Node and Python.'
---

## Quick start

Install the server, with `ws` for Node's HTTP server and Zod for payloads:

```bash
npm install @chanx-js/server ws zod
```

Then the client, and generate its types from the running server:

```bash
npm install @chanx-js/client
# writes src/generated
npx @chanx-js/codegen http://localhost:8000/asyncapi.json
```

::: code-group

```ts [server.ts]
import { createServer } from 'node:http';
import { z } from 'zod';
import {
  PingMessage,
  PongMessage,
  consumer,
  createChanx,
  defineMessage,
} from '@chanx-js/server';
import {
  asyncapiMiddleware,
  attachChanx,
} from '@chanx-js/server/node';

const Chat = defineMessage('chat', z.object({ text: z.string() }));
const Notice = defineMessage(
  'notice',
  z.object({ text: z.string() }),
);

const chat = consumer('/ws/chat/{room}', {
  name: 'chat',
  groups: (conn) => [`room.${conn.params.room}`],
})
  .on(PingMessage, { output: PongMessage }, () =>
    PongMessage.create(),
  )
  .on(Chat, { output: Notice }, (m, ctx) =>
    ctx.broadcast(Notice.create({ text: m.payload.text })),
  );

const chanx = createChanx({ consumers: [chat] });
// docs at /asyncapi
const server = createServer(asyncapiMiddleware(chanx));
attachChanx(server, chanx);
server.listen(8000);
```

```ts [client.ts]
import { createClient } from '@chanx-js/client';
import { chat } from './src/generated/index.js';

const client = createClient({ baseUrl: 'ws://localhost:8000' });
const connection = client.connect(chat, {
  params: { room: 'lobby' },
});

connection.on('notice', (message) =>
  console.log(message.payload.text),
);
// typed: PongMessage
const pong = await connection.request({ action: 'ping' });
connection.send({ action: 'chat', payload: { text: 'hello' } });
```

:::

Run the server, then the client: it prints `hello`, broadcast back to everyone in
`lobby`. From here, [build out the server](/server/) or
[use the client in your framework](/client/).
