# @chanx-js/client

Type-safe WebSocket client for TypeScript. Generate it from a server's AsyncAPI schema,
and every message you send and receive is typed: in the browser, React, Vue, Svelte,
Solid, or another Node service. No runtime dependencies.

**[Documentation](https://huynguyengl99.github.io/chanx-js/)** · [Getting started](https://huynguyengl99.github.io/chanx-js/client/) ·
[Why chanx-js?](https://huynguyengl99.github.io/chanx-js/introduction/why) · [API](https://huynguyengl99.github.io/chanx-js/api/)

```bash
npm install @chanx-js/client
npm install -D @chanx-js/codegen
npx chanx-codegen http://localhost:8000/asyncapi.json   # writes src/generated
```

```ts
import { createClient } from '@chanx-js/client';

import { chat } from './src/generated/index.js';

const client = createClient({ baseUrl: 'ws://localhost:8000' });
const connection = client.connect(chat, { params: { room: 'lobby' } });

connection.on('notice', (message) => console.log(message.payload.text));
const pong = await connection.request({ action: 'ping' }); // typed: PongMessage
connection.send({ action: 'chat', payload: { text: 'hello' } });
```

- **Typed both ways:** a misspelt action or field is a compile error, and
  `request()` resolves with the reply its action declares.
- **Topics:** many subscriptions over one socket, restored after a reconnect.
- **Reconnects and heartbeats** built in, and sockets shared safely between components.
- **Works with any chanx server,** [Node](https://huynguyengl99.github.io/chanx-js/server/) or
  [Python](https://github.com/huynguyengl99/chanx).

| Import                    | For                                       |
| ------------------------- | ----------------------------------------- |
| `@chanx-js/client`        | The runtime: clients, connections, topics |
| `@chanx-js/client/react`  | `useChannel`, `useTopic`, `useTopics`     |
| `@chanx-js/client/vue`    | Composables returning refs                |
| `@chanx-js/client/svelte` | Stores, for Svelte 4 and 5                |
| `@chanx-js/client/solid`  | Signals and accessors                     |

MIT licensed.
