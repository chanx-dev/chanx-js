# Build a chat server

In this tutorial you build the server for a chat app: people join a room under a name,
see what was said before they arrived and who is online, and talk. Along the way you use
the core of `@chanx-js/server`: messages, a consumer with authentication and groups,
lifecycle hooks, AsyncAPI, and tests.

It takes about twenty minutes. The [next tutorial](./chat-ui) builds a React UI for it.

## Set up the project

You need Node 22 or later.

```bash
mkdir chat-server && cd chat-server
npm init -y && npm pkg set type=module
npm install @chanx-js/server ws zod
npm install -D typescript tsx vitest @types/node
```

Add two scripts to `package.json`:

```json
"scripts": {
  "dev": "tsx watch src/server.ts",
  "test": "vitest run"
}
```

And a `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

## Define the messages

Every message has an action and a payload. Start with what travels each way. Create
`src/messages.ts`:

```ts
import { z } from 'zod';
import { defineMessage } from '@chanx-js/server';

const Line = z.object({
  user: z.string(),
  text: z.string(),
  at: z.number(),
});
export type Line = z.infer<typeof Line>;

// From the client
export const Say = defineMessage(
  'say',
  z.object({ text: z.string().min(1).max(500) }),
);

// From the server
export const Said = defineMessage('said', Line);
export const History = defineMessage(
  'history',
  z.object({ lines: z.array(Line) }),
);
export const Online = defineMessage(
  'online',
  z.object({ users: z.array(z.string()) }),
);
```

The schemas do double duty. At runtime they validate: a `say` with an empty `text` never
reaches your code. In TypeScript, they type every handler. And they become the
AsyncAPI document the client is generated from.

## Keep the room state

The server remembers each room's last 50 lines and who is in it. Create `src/rooms.ts`:

```ts
import type { Line } from './messages.js';

interface Room {
  lines: Line[];
  /** Connection id to user name: a user may have several tabs. */
  members: Map<string, string>;
}

const rooms = new Map<string, Room>();

export function room(name: string): Room {
  let found = rooms.get(name);
  if (!found)
    rooms.set(name, (found = { lines: [], members: new Map() }));
  return found;
}

export function onlineUsers(room: Room): string[] {
  return [...new Set(room.members.values())].sort();
}
```

This is plain process memory, which is fine for one server. [Scaling out](#scale-out)
covers what changes with several.

## Write the consumer

A consumer serves one WebSocket route. Create `src/chat.ts`:

```ts
import {
  PingMessage,
  PongMessage,
  consumer,
} from '@chanx-js/server';

import { History, Online, Said, Say } from './messages.js';
import { onlineUsers, room } from './rooms.js';

export const chat = consumer('/ws/chat/{room}', {
  name: 'chat',
  emits: [History, Online],
  authenticate: ({ url }) => {
    const name = url.searchParams.get('name')?.trim();
    return name ? { name } : false;
  },
  groups: (conn) => [`room.${conn.params.room}`],
  onConnect: async (ctx) => {
    const current = room(ctx.params.room);
    current.members.set(ctx.conn.id, ctx.conn.user.name);
    await ctx.push(History.create({ lines: current.lines }));
    await ctx.broadcast(
      Online.create({ users: onlineUsers(current) }),
    );
  },
  onDisconnect: async (ctx) => {
    const current = room(ctx.params.room);
    current.members.delete(ctx.conn.id);
    await ctx.broadcast(
      Online.create({ users: onlineUsers(current) }),
      {
        excludeCurrent: true,
      },
    );
  },
})
  .on(PingMessage, { output: PongMessage }, () =>
    PongMessage.create(),
  )
  .on(Say, { output: Said }, async (m, ctx) => {
    const line = {
      user: ctx.conn.user.name,
      text: m.payload.text,
      at: Date.now(),
    };
    const current = room(ctx.params.room);
    current.lines = [...current.lines, line].slice(-50);
    await ctx.broadcast(Said.create(line));
  });
```

Piece by piece:

- **The route** `/ws/chat/{room}` has a path param. `ctx.params.room` is typed from it.
- **`authenticate`** runs once the socket is accepted. Whatever it returns becomes
  `ctx.conn.user`, typed: here `{ name: string }`. Returning `false` refuses the client,
  which then gets an `authentication` message with status 401 and is disconnected.
  A real app would check a token here instead of trusting a name.
- **`groups`** puts each connection in its room's group. `ctx.broadcast()` sends to
  every connection in the groups, the sender included.
- **`onConnect`** runs once the client is authenticated and in its groups. It sends the
  newcomer the history with `ctx.push()`, to that client only, then tells the whole room
  who is online.
- **`onDisconnect`** runs when the socket closes, before the connection leaves its
  groups, so it can still tell the others.
- **`emits`** lists what the consumer sends outside its handlers, here from `onConnect`
  and `onDisconnect`. TypeScript holds `ctx.push` and `ctx.broadcast` to these, and
  AsyncAPI documents them.
- **`.on(Say, { output: Said }, ...)`** handles a `say`. It records the line and
  broadcasts it; `output` declares the broadcast as it would a reply.
- **`.on(PingMessage, { output: PongMessage }, ...)`** answers pings. Returning a message
  replies to the sender, with the request's `ref`, so `connection.request()` on the
  client resolves with it. Declaring ping and pong also turns on the client's heartbeat.

## Serve it

Collect the consumers into an app, in `src/app.ts`:

```ts
import { createChanx } from '@chanx-js/server';

import { chat } from './chat.js';

export const chanx = createChanx({ consumers: [chat] });
```

And serve it on Node's HTTP server, in `src/server.ts`:

```ts
import { createServer } from 'node:http';
import {
  asyncapiMiddleware,
  attachChanx,
} from '@chanx-js/server/node';

import { chanx } from './app.js';

const server = createServer(asyncapiMiddleware(chanx));
attachChanx(server, chanx);
server.listen(8000, () =>
  console.log('Chat server on http://localhost:8000/asyncapi'),
);
```

Keeping the app apart from the server lets the tests use it without a network. Start
it:

```bash
npm run dev
```

Open [localhost:8000/asyncapi](http://localhost:8000/asyncapi). The page documents the
`chat` channel: the `say` it receives, the `said`, `history` and `online` it sends, and
the ping it answers with a pong. This is the contract the client is generated from.

## Test it

`@chanx-js/server/testing` connects to the app in-process, with no port or network.
Create `tests/chat.test.ts`:

```ts
import { connect } from '@chanx-js/server/testing';
import { expect, test } from 'vitest';

import { chanx } from '../src/app.js';
import { Say } from '../src/messages.js';

async function join(room: string, name: string) {
  const client = connect(chanx, `/ws/chat/${room}?name=${name}`);
  expect(await client.ready).toBe(true);
  // the history, then who is here
  await client.receiveUntil('online');
  return client;
}

test('refuses a client without a name', async () => {
  const client = connect(chanx, '/ws/chat/lobby');
  expect(await client.ready).toBe(false);
});

test('broadcasts what one user says to the room', async () => {
  const ann = await join('lobby', 'ann');
  const bob = await join('lobby', 'bob');
  await ann.receive(); // bob's arrival: the new online list

  await bob.sendMessage(Say.create({ text: 'hi' }));

  expect(await ann.receive()).toMatchObject({
    action: 'said',
    payload: { user: 'bob', text: 'hi' },
  });
});

test('sends a newcomer the room so far', async () => {
  const ann = await join('history', 'ann');
  await ann.sendMessage(Say.create({ text: 'first' }));
  await ann.receive();

  const bob = connect(chanx, '/ws/chat/history?name=bob');
  await bob.receiveUntil('authentication');

  expect(await bob.receive()).toMatchObject({
    action: 'history',
    payload: { lines: [{ user: 'ann', text: 'first' }] },
  });
});

test('updates the online list as people come and go', async () => {
  const ann = await join('presence', 'ann');
  const bob = await join('presence', 'bob');
  expect(await ann.receive()).toMatchObject({
    payload: { users: ['ann', 'bob'] },
  });

  await bob.close();

  expect(await ann.receive()).toMatchObject({
    payload: { users: ['ann'] },
  });
});

test('rejects an empty message', async () => {
  const ann = await join('lobby', 'ann');

  await ann.sendMessage(Say.create({ text: '' }));

  expect(await ann.receive()).toMatchObject({ action: 'error' });
});
```

```bash
npm test
```

Each test client sees exactly what a real one would: first the `authentication`
message, then whatever the consumer sends. `receiveUntil(action)` skips ahead to a
message, and `receive()` waits for the next. The rooms state is shared across tests, so
each test uses its own room. [Testing](/server/testing) lists every helper, including
captures that check a broadcast without a second client.

## Scale out

Groups live in a channel layer. By default it is in memory, so a broadcast reaches only
the connections in this process. To run several processes behind a load balancer, give
them a shared Redis layer:

```bash
npm install @chanx-js/layers redis
```

```ts
import { createChanx } from '@chanx-js/server';
import { RedisPubSubChannelLayer } from '@chanx-js/layers/redis';

import { chat } from './chat.js';

export const chanx = createChanx({
  consumers: [chat],
  layers: {
    default: new RedisPubSubChannelLayer({
      hosts: [process.env.REDIS_URL!],
    }),
  },
});
```

Broadcasts now reach every process. The rooms state in `src/rooms.ts` does not: move it
to Redis or a database too. See [Channel layers](/server/layers).

## Next

- [Build a chat UI in React](./chat-ui) for this server.
- Serve it from [Express, Fastify, Hono, Bun or NestJS](/server/integrations/) instead.
- [Topics](/server/topics) let one connection follow many rooms at once.
