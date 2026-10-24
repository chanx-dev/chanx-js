# Client: getting started

The client connects to any chanx server, [Node](/server/) or
[Python](https://github.com/huynguyengl99/chanx), from a browser, a framework app or
another service. Two packages make it up:

- **`@chanx-js/client`**: the runtime. No dependencies and framework-agnostic, with
  bindings on `@chanx-js/client/react`, `@chanx-js/client/vue`, `@chanx-js/client/svelte`
  and `@chanx-js/client/solid`.
- **`@chanx-js/codegen`**: a CLI that turns the server's AsyncAPI 3 schema into typed
  channel descriptors.

## Install

::: code-group

```bash [pnpm]
pnpm add @chanx-js/client
pnpm add -D @chanx-js/codegen
```

```bash [npm]
npm install @chanx-js/client
npm install -D @chanx-js/codegen
```

```bash [yarn]
yarn add @chanx-js/client
yarn add -D @chanx-js/codegen
```

:::

Both packages are ESM only. The types need TypeScript 5.0 or later.

## Generate a client

chanx serves its AsyncAPI schema over HTTP. Point the generator at it:

```bash
npx @chanx-js/codegen http://localhost:8000/asyncapi.json -o src/generated
```

This writes three files:

| File          | Contains                                                                   |
| ------------- | -------------------------------------------------------------------------- |
| `schemas.ts`  | One type per message and payload in the schema                             |
| `channels.ts` | A descriptor per channel, with topics nested under the connection they use |
| `index.ts`    | Re-exports both                                                            |

Commit the output and regenerate whenever the server's schema changes. See [Code generation](/client/codegen) for every option, including JavaScript output and reusing types you already have.

## Connect

```ts
import { createClient } from '@chanx-js/client';

import { chat } from './generated';

const client = createClient({ baseUrl: 'wss://api.example.com' });
const connection = client.connect(chat, { params: { room: 'lobby' } });

connection.on('chat_notification', (message) => {
  console.log(message.payload.message); // narrowed by `action`
});

connection.send({ action: 'chat', payload: { message: 'hello' } });
```

`params` is checked against the channel's address, so `chat` at `/ws/chat/{room}/` requires `room`. Every message is typed from the schema: sending an action the server does not accept, or reading a field a message does not have, fails to compile.

## In a component

::: code-group

```tsx [React]
import { useChannel } from '@chanx-js/client/react';

function ChatPanel({ room }: { room: string }) {
  const { lastMessage, status, send } = useChannel(chat, { params: { room } });
  // ...
}
```

```ts [Vue]
import { useChannel } from '@chanx-js/client/vue';

const { lastMessage, status, send } = useChannel(chat, { params: { room: 'lobby' } });
```

```ts [Svelte]
import { createChannel } from '@chanx-js/client/svelte';

const channel = createChannel(chat, { params: { room: 'lobby' } });
// $channel.status, $channel.lastMessage
```

```tsx [Solid]
import { createChannel } from '@chanx-js/client/solid';

const channel = createChannel(chat, { params: { room: 'lobby' } });
// channel.status(), channel.lastMessage()
```

:::

Components on a channel that carries topics share one socket, which closes when the last of them unmounts. A plain channel gives each component its own socket unless you pass `share: true`; see [Sharing and closing](/client/sharing).

## Next

- [Build a chat UI in React](/tutorials/chat-ui): a whole client, step by step.
- [Connections](/client/connections): options, requests, reconnects and the heartbeat.
- [Topics](/client/topics): many streams over one socket.
- Your framework: [React](/client/integrations/react), [Vue](/client/integrations/vue),
  [Svelte](/client/integrations/svelte), [Solid](/client/integrations/solid), or
  [a Node service](/client/integrations/node).
