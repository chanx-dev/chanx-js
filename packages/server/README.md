# @chanx-js/server

Type-safe WebSocket server for TypeScript. Declare messages once: each action gets a
validated, typed handler, groups broadcast across processes, and the whole API is
documented as AsyncAPI, from which [`@chanx-js/codegen`](https://js.chanx.dev/client/codegen) generates
a typed client.

Runs on Node with `ws`, Express, Koa, Fastify, Hono, NestJS, Bun and Deno.

**[Documentation](https://js.chanx.dev/)** · [Getting started](https://js.chanx.dev/server/) ·
[Why chanx-js?](https://js.chanx.dev/introduction/why) · [API](https://js.chanx.dev/api/)

```bash
npm install @chanx-js/server ws zod
```

```ts
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
const server = createServer(asyncapiMiddleware(chanx)); // docs at /asyncapi
attachChanx(server, chanx);
server.listen(8000);
```

- **Handlers, not if/else:** payloads are validated by any Standard Schema library
  (Zod, Valibot, ArkType) before your handler runs.
- **Groups and topics:** broadcast to rooms, and let clients subscribe to many streams
  over one socket. Across processes with [`@chanx-js/layers`](https://js.chanx.dev/server/layers).
- **Runs anywhere:** Node's `http`, Express, Koa, Fastify, Hono, Bun, Deno, and
  [NestJS](https://js.chanx.dev/server/integrations/nestjs). See [integrations](https://js.chanx.dev/server/integrations/).
- **Testing:** an in-process client and broadcast captures, from
  `@chanx-js/server/testing`.
- **Compatible with Python [chanx](https://github.com/chanx-dev/chanx):** same
  protocol, same AsyncAPI, one Redis shared by both.

MIT licensed.
