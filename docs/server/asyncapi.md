# AsyncAPI

`chanx.asyncapi()` documents every consumer and topic as an AsyncAPI 3 document, laid
out as Python's chanx lays it out. [`@chanx-js/codegen`](/client/codegen) turns it
into a typed client exactly as it would a Python server's.

## Serve it

`asyncapiHandler` serves what chanx's views serve: a docs page at `/asyncapi`, rendered
by the AsyncAPI React component, and the document at `/asyncapi.json` and
`/asyncapi.yaml`. It is a Fetch handler, returning `undefined` for paths it does not
serve:

```ts
import { asyncapiHandler } from '@chanx-js/server';

const asyncapi = asyncapiHandler(chanx, {
  title: 'Chat API',
  version: '1.2.0',
});

// Hono
app.get(
  '/asyncapi*',
  async (c, next) => (await asyncapi(c.req.raw)) ?? next(),
);

// Bun, Deno, Workers
export default {
  fetch: async (request) =>
    (await asyncapi(request)) ??
    new Response(null, { status: 404 }),
};
```

On Node, `asyncapiMiddleware` from `@chanx-js/server/node` is the same as Express or
Connect middleware:

```ts
import { asyncapiMiddleware } from '@chanx-js/server/node';

expressApp.use(asyncapiMiddleware(chanx, { title: 'Chat API' }));
```

- `path` moves it: `{ path: '/docs/ws' }` serves `/docs/ws`, `/docs/ws.json` and
  `/docs/ws.yaml`.
- The server's host and protocol default to the request's (`wss` over HTTPS). Set
  `serverUrl` and `serverProtocol` behind a proxy.
- YAML needs the [`yaml`](https://www.npmjs.com/package/yaml) package; without it, the
  YAML path answers 400.
- A document that cannot be generated answers 500 and is logged through the app's
  logger.

Then generate the client:

```bash
npx @chanx-js/codegen http://localhost:8000/asyncapi.json \
  -o src/generated
```

`chanx.asyncapi()` returns the document itself, to write it to a file in CI or serve it
your own way.

## What it documents

- **A channel per consumer**, named by its `name`, with its path params. Topics get
  their own channel, marked with chanx's `x-topic` extension.
- **An operation per handler.** A message handler is `receive`, with a `reply` listing
  its `output`, returned or broadcast. An event or a consumer's `emits` is `send`.
- **A component per message,** under its `title` (`ChatMessage` for `chat` by default).
  Request and reply messages carry a `correlationId` pointing at the frame's `ref`.

Operations are named `handle_<action>`, or after the method for a class handler. Set
`name` in a handler's options to choose one. Handlers take `summary`,
`description` and `tags`, consumers `description` and `tags`, topics `description`.

## Payload schemas

Payload schemas come from [Standard JSON Schema](https://standardschema.dev/json-schema):
Zod 4 and ArkType natively, Valibot through `toStandardJsonSchema`. Give a payload a
title, such as Zod's `.meta({ title: 'ChatPayload' })`, to document it as a named
component, as pydantic models are. Two different schemas under one title are an error.

## Security

A consumer's `credentials` each become a security scheme named `<location>_<name>`, such
as `query_token`. Its operations list them (any one is enough), and query and header ones
go in the channel's WebSocket binding, which describes the handshake. Topics take their
host's.

```ts
chanx.asyncapi({
  servers: {
    production: {
      host: 'api.example.com',
      protocol: 'wss',
      security: [
        { $ref: '#/components/securitySchemes/query_token' },
      ],
    },
  },
  securitySchemes: { oauth: { type: 'oauth2' } },
});
```

`servers` replaces the one built from `serverUrl` and `serverProtocol`. A declared scheme
with the same name as a credential's replaces it.

## Options

| Option           | Default                  |
| ---------------- | ------------------------ |
| `title`          | `AsyncAPI Documentation` |
| `version`        | `1.0.0`                  |
| `description`    | empty                    |
| `serverUrl`      | `localhost:8000`         |
| `serverProtocol` | `ws`                     |

`termsOfService`, `contact`, `license`, `tags` and `externalDocs` go into the
document's `info` when given; `servers` and `securitySchemes` are described
[above](#security).

The docs page loads `@asyncapi/react-component` from unpkg, pinned to one release and
checked by [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)
hashes. To serve it without a CDN, point `docs` at your own copies; a custom URL drops
the pinned hash, so pass your own:

```ts
asyncapiHandler(chanx, {
  docs: {
    jsUrl: '/static/asyncapi/index.js',
    cssUrl: '/static/asyncapi/default.min.css',
    jsIntegrity: 'sha384-...',
  },
});
```

The component evaluates code at runtime, so a Content Security Policy must allow
`unsafe-eval` on the docs page.

With `createChanx({ camelize: true })`, names and properties are camelCased as chanx
does, while schema names keep their titles.
