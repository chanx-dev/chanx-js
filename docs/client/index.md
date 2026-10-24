# Client: getting started

Generate a WebSocket client from your server's schema, and every message you send and
receive is typed: a misspelt action or field fails to compile, and a request resolves with
its typed reply. It reconnects, keeps heartbeats, and multiplexes topics over one socket,
in a browser, a framework app or another service. It works with any chanx server,
[Node](/server/) or [Python](https://github.com/huynguyengl99/chanx); for how it compares
with other options, see [Why chanx-js?](/introduction/why).

Two packages make it up:

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
npx @chanx-js/codegen http://localhost:8000/asyncapi.json \
  -o src/generated
```

This writes three files:

| File          | Contains                                                                   |
| ------------- | -------------------------------------------------------------------------- |
| `schemas.ts`  | One type per message and payload in the schema                             |
| `channels.ts` | A descriptor per channel, with topics nested under the connection they use |
| `index.ts`    | Re-exports both                                                            |

Commit the output and regenerate whenever the server's schema changes. See [Code generation](/client/codegen) for every option, including JavaScript output and reusing types you already have.

## Connect

The examples connect to the chat server from [Server: getting started](/server/), which
generates a `chat` channel at `/ws/chat/{room}` that receives `chat` and sends `notice`.
Each tab is a complete file:

::: code-group

```ts [Node]
// client.ts: a script or a service
import { createClient } from '@chanx-js/client';

import { chat } from './generated/index.js';

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

```tsx [React]
// ChatPanel.tsx
import { useState } from 'react';
import {
  setDefaultClient,
  useChannel,
} from '@chanx-js/client/react';

import { chat } from './generated';

// once, in your app's entry
setDefaultClient({ baseUrl: 'ws://localhost:8000' });

export function ChatPanel({ room }: { room: string }) {
  const [notices, setNotices] = useState<string[]>([]);
  const { status, send } = useChannel(chat, {
    params: { room },
    buffer: 'none',
    on: {
      notice: (message) =>
        setNotices((all) => [...all, message.payload.text]),
    },
  });

  return (
    <div>
      <p>{status}</p>
      <ul>
        {notices.map((text, i) => (
          <li key={i}>{text}</li>
        ))}
      </ul>
      <button
        onClick={() =>
          send({ action: 'chat', payload: { text: 'hello' } })
        }
      >
        Say hello
      </button>
    </div>
  );
}
```

```vue [Vue]
<!-- ChatPanel.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { setDefaultClient, useChannel } from '@chanx-js/client/vue';

import { chat } from './generated';

// once, in your app's entry
setDefaultClient({ baseUrl: 'ws://localhost:8000' });

const props = defineProps<{ room: string }>();
const notices = ref<string[]>([]);
const { status, send } = useChannel(chat, {
  // a new room reconnects
  params: computed(() => ({ room: props.room })),
  buffer: 'none',
  on: {
    notice: (message) => notices.value.push(message.payload.text),
  },
});
</script>

<template>
  <p>{{ status }}</p>
  <ul>
    <li v-for="(text, i) in notices" :key="i">{{ text }}</li>
  </ul>
  <button
    @click="send({ action: 'chat', payload: { text: 'hello' } })"
  >
    Say hello
  </button>
</template>
```

```svelte [Svelte]
<!-- ChatPanel.svelte -->
<script lang="ts">
  import {
    createChannel,
    setDefaultClient,
  } from '@chanx-js/client/svelte';

  import { chat } from './generated';

  // once, in your app's entry
  setDefaultClient({ baseUrl: 'ws://localhost:8000' });

  let { room }: { room: string } = $props();
  let notices = $state<string[]>([]);
  // Options are read once: wrap the component in {#key room}
  // to switch rooms.
  // svelte-ignore state_referenced_locally
  const channel = createChannel(chat, {
    params: { room },
    buffer: 'none',
    on: { notice: (message) => notices.push(message.payload.text) },
  });
</script>

<p>{$channel.status}</p>
<ul>
  {#each notices as text}
    <li>{text}</li>
  {/each}
</ul>
<button
  onclick={() =>
    channel.send({ action: 'chat', payload: { text: 'hello' } })}
>
  Say hello
</button>
```

```tsx [Solid]
// ChatPanel.tsx
import { For, createSignal } from 'solid-js';
import {
  createChannel,
  setDefaultClient,
} from '@chanx-js/client/solid';

import { chat } from './generated';

// once, in your app's entry
setDefaultClient({ baseUrl: 'ws://localhost:8000' });

export function ChatPanel(props: { room: string }) {
  const [notices, setNotices] = createSignal<string[]>([]);
  // Options are read once: key the component on the room to
  // switch rooms.
  const channel = createChannel(chat, {
    params: { room: props.room },
    buffer: 'none',
    on: {
      notice: (message) =>
        setNotices((all) => [...all, message.payload.text]),
    },
  });

  return (
    <div>
      <p>{channel.status()}</p>
      <ul>
        <For each={notices()}>{(text) => <li>{text}</li>}</For>
      </ul>
      <button
        onClick={() =>
          channel.send({
            action: 'chat',
            payload: { text: 'hello' },
          })
        }
      >
        Say hello
      </button>
    </div>
  );
}
```

:::

What every tab shares:

- **`params`** is checked against the channel's address, so `/ws/chat/{room}` requires
  `room`.
- **Every message is typed from the schema.** In the `notice` handler,
  `message.payload.text` is a `string`; sending an action the server does not accept, or
  a field a message does not have, fails to compile.
- **`setDefaultClient`** points every component at the server. Call it once, in your
  app's entry; React also takes a `ChanxClientProvider`, and Vue an `app.use(chanxPlugin)`.
- In React and Vue, a new `room` reconnects. Svelte and Solid read their options once.

Components on a channel that carries topics share one socket, which closes when the last
of them unmounts. A plain channel gives each component its own socket unless you pass
`share: true`; see [Sharing and closing](/client/sharing). Each framework's page covers
the rest: [React](/client/integrations/react), [Vue](/client/integrations/vue),
[Svelte](/client/integrations/svelte), [Solid](/client/integrations/solid) and
[Node](/client/integrations/node).

## Next

- [Build a chat UI in React](/tutorials/chat-ui): a whole client, step by step.
- [Connections](/client/connections): options, requests, reconnects and the heartbeat.
- [Topics](/client/topics): many streams over one socket.
- Your framework: [React](/client/integrations/react), [Vue](/client/integrations/vue),
  [Svelte](/client/integrations/svelte), [Solid](/client/integrations/solid), or
  [a Node service](/client/integrations/node).
