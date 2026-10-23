# @chanx-js/server

chanx for Node: typed WebSocket consumers speaking the same protocol as Python's
[chanx](https://github.com/huynguyengl99/chanx), so `@chanx-js/client` and generated
clients work against either server.

In development; see the repository's design notes. Not yet published.

```ts
import { z } from 'zod';
import {
  PingMessage,
  PongMessage,
  consumer,
  createChanx,
  defineMessage,
} from '@chanx-js/server';

const Chat = defineMessage('chat', z.object({ text: z.string() }));
const Notice = defineMessage('notice', z.object({ text: z.string() }));

const chat = consumer('/ws/chat/{room}', { name: 'chat', emits: [Notice] })
  .on(PingMessage, { output: PongMessage }, () => PongMessage.create())
  .on(Chat, async (m, ctx) => {
    await ctx.send(Notice.create({ text: `${ctx.params.room}: ${m.payload.text}` }));
  });

export const chanx = createChanx({ consumers: [chat] });
```

Payloads are validated by any [Standard Schema](https://standardschema.dev) library:
Zod, Valibot, ArkType and others. Validation errors reach the client in the shape
chanx's pydantic errors have.

`@chanx-js/server/testing` connects to an app in-process, without a network:

```ts
import { connect } from '@chanx-js/server/testing';

const client = connect(chanx, '/ws/chat/lobby');
const reply = await client.request({ action: 'ping' });
```
