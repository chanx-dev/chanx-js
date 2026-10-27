# Plain JavaScript

Every chanx-js package ships as JavaScript with its types alongside, so you can use
chanx-js without TypeScript. Your editor still checks your messages: the types come from
the published `.d.mts` files and from the generated `.d.ts` files, not from your code.
The guide's examples are TypeScript, but most of them run unchanged as `.js`.

## The client

Generate JavaScript instead of TypeScript with `--emit js`:

```bash
npx @chanx-js/codegen http://localhost:8000/asyncapi.json \
  -o src/generated --emit js
```

Each module comes out as a runtime `.js` file and a `.d.ts` that carries its types.
Import the `.js` file:

```js
import { createClient } from '@chanx-js/client';
import { chat } from './src/generated/index.js';

const client = createClient({ baseUrl: 'ws://localhost:8000' });
const connection = client.connect(chat, {
  params: { room: 'lobby' },
});

connection.on('notice', (message) =>
  console.log(message.payload.text),
);
connection.send({ action: 'chat', payload: { text: 'hello' } });
```

`message.payload.text` is typed, and once [checking is on](#checking-your-code), sending
an action the server does not accept is an error. See [Code generation](/client/codegen#javascript-output) for the files it writes.

## The server

The builder API (`defineMessage`, `consumer`, `createChanx`) needs no TypeScript
syntax. The files in [Server: getting started](/server/) run as they are once saved as
`.js`, and handlers are typed from their message: `m.payload`, `ctx.params` and
`ctx.send` are all checked.

Two parts of chanx-js need a compiler:

- **[Classes](/server/classes)** use decorators, which JavaScript runtimes do not run
  yet. Use them with TypeScript or Babel, or use the builder.
- **[NestJS](/server/integrations/nestjs)** relies on TypeScript decorators and their
  metadata, so a NestJS app is written in TypeScript.

## Checking your code

Editors show the types in JavaScript files without any setup. To have mistakes
reported as errors, add `// @ts-check` at the top of a file, or check the whole project
with a `jsconfig.json`:

```json
{
  "compilerOptions": {
    "checkJs": true,
    "strict": true,
    "module": "nodenext",
    "target": "es2022",
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`npx tsc -p jsconfig.json` then checks it in CI too. TypeScript is a dev dependency
only; nothing ships with it.

For a working example, see
[`conformance-js`](https://github.com/chanx-dev/chanx-js/tree/main/conformance-js) in the
repository: a JavaScript client and server, checked this way on every change.
