# Build a chat UI in React

In this tutorial you build a React front end for the server from
[Build a chat server](./chat-server): pick a name, join the lobby, see its history and
who is online, and chat. You use `@chanx-js/codegen` to type the client from the server,
and the `useChannel` hook to drive the UI.

Start the chat server first, with `npm run dev` in its folder, so it is listening on
port 8000.

## Set up the project

Create a Vite app beside the server, and add the client and the generator:

```bash
npm create vite@latest chat-ui -- --template react-ts
cd chat-ui
npm install @chanx-js/client
npm install -D @chanx-js/codegen
```

## Generate the client

With the server running:

```bash
npx chanx-codegen http://localhost:8000/asyncapi.json
```

This reads the server's AsyncAPI document and writes `src/generated`:

- `schemas.ts`: a type per message, such as `SaidMessage` with its `user`, `text` and
  `at`.
- `channels.ts`: the `chat` channel, which knows its address (`/ws/chat/{room}`), what
  it can send (`say`, `ping`) and what it receives (`said`, `history`, `online`,
  `pong`). It is marked `heartbeat: true`, because the server answers pings.

Commit these files, and run the command again whenever the server's messages change.
If the server renames a field, the regenerated types make the compiler point at every
line of the UI that needs updating.

## Provide a client

A client holds the server's base URL and the sockets it opens. Provide one to the app,
in `src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@chanx-js/client';
import { ChanxClientProvider } from '@chanx-js/client/react';

import App from './App.tsx';
import './index.css';

const client = createClient({ baseUrl: 'ws://localhost:8000' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChanxClientProvider value={client}>
      <App />
    </ChanxClientProvider>
  </StrictMode>,
);
```

## Ask for a name

The server refuses a connection without a name, so ask for one first. Replace
`src/App.tsx`:

```tsx
import { useState, type FormEvent } from 'react';

import { ChatRoom } from './ChatRoom.tsx';

export default function App() {
  const [name, setName] = useState('');
  const [joined, setJoined] = useState(false);

  function join(event: FormEvent) {
    event.preventDefault();
    setJoined(true);
  }

  if (joined) return <ChatRoom room="lobby" name={name.trim()} />;

  return (
    <form onSubmit={join}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name"
      />
      <button disabled={!name.trim()}>Join</button>
    </form>
  );
}
```

## Write the chat room

Create `src/ChatRoom.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useChannel } from '@chanx-js/client/react';

import { chat, type SaidMessage } from './generated';

type Line = SaidMessage['payload'];

export function ChatRoom({
  room,
  name,
}: {
  room: string;
  name: string;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [online, setOnline] = useState<string[]>([]);
  const [draft, setDraft] = useState('');

  const { status, send } = useChannel(chat, {
    params: { room },
    queryParams: { name },
    buffer: 'none',
    on: {
      history: (message) => setLines(message.payload.lines),
      said: (message) =>
        setLines((lines) => [...lines, message.payload]),
      online: (message) => setOnline(message.payload.users),
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    send({ action: 'say', payload: { text: draft } });
    setDraft('');
  }

  return (
    <main>
      <h1>
        #{room} <small>{status}</small>
      </h1>
      <p>Online: {online.join(', ')}</p>
      <ul>
        {lines.map((line) => (
          <li key={`${line.at}-${line.user}`}>
            <b>{line.user}</b>: {line.text}
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button disabled={!draft.trim()}>Send</button>
      </form>
    </main>
  );
}
```

`useChannel(chat, options)` opens the connection when the component mounts, and closes
it when it unmounts:

- **`params`** fills the address: `{ room: 'lobby' }` connects to `/ws/chat/lobby`.
  Its type comes from the address, so leaving out `room` does not compile.
- **`queryParams`** adds `?name=ann`, which the server's `authenticate` reads. A change to
  `params` or `queryParams` reconnects.
- **`buffer: 'none'`** with **`on`** calls a handler per action, instead of keeping
  messages in React state for you. Each handler's `message` is narrowed by its action:
  in `said`, `message.payload.user` is a `string`, and a misspelt action is an error.
- **`status`** is `connecting`, `open`, `reconnecting` or `closed`.
- **`send`** accepts only what the server receives: `{ action: 'say', payload: { text } }`
  compiles, `{ action: 'say', payload: { txt } }` does not.

## Run it

```bash
npm run dev
```

Open the app in two browser windows, join under two names, and chat. Each window shows
the other's messages as they are sent, and the online list updates as windows open and
close. A window opened later gets the conversation so far, from the history the server
pushes on connect.

Stop the server and start it again: the status reads `reconnecting`, then `open`. The
client reconnects with backoff, and the server pushes the history and online list again,
which replace what the room had. (This server keeps history in memory, so after a
restart it is empty.)

React's StrictMode mounts each component twice in development. The client keeps one
socket through the double mount, rather than connecting twice.

## Next

- [React](/client/integrations/react): `useTopic`, delivery modes and wrapping hooks for
  your app.
- [Delivery modes](/client/delivery): `lastMessage`, accumulating buffers, and batching
  for fast streams.
- The same client in [Vue](/client/integrations/vue),
  [Svelte](/client/integrations/svelte), [Solid](/client/integrations/solid) or
  [a Node service](/client/integrations/node).
