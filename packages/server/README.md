# @chanx-js/server

Type-safe WebSocket server for TypeScript. Declare messages once: each action gets a
validated, typed handler, groups broadcast across processes, and the whole API is
documented as AsyncAPI, from which [`@chanx-js/codegen`](https://huynguyengl99.github.io/chanx-js/client/codegen) generates
a typed client.

**[Documentation](https://huynguyengl99.github.io/chanx-js/)** · [Getting started](https://huynguyengl99.github.io/chanx-js/server/) ·
[Why chanx-js?](https://huynguyengl99.github.io/chanx-js/introduction/why) · [API](https://huynguyengl99.github.io/chanx-js/api/)

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
  over one socket. Across processes with [`@chanx-js/layers`](https://huynguyengl99.github.io/chanx-js/server/layers).
- **Runs anywhere:** Node's `http`, Express, Koa, Fastify, Hono, Bun, Deno, and
  [NestJS](https://huynguyengl99.github.io/chanx-js/server/integrations/nestjs). See [integrations](https://huynguyengl99.github.io/chanx-js/server/integrations/).
- **Testing:** an in-process client and broadcast captures, from
  `@chanx-js/server/testing`.
- **Compatible with Python [chanx](https://github.com/huynguyengl99/chanx):** same
  protocol, same AsyncAPI, one Redis shared by both.

MIT licensed.
