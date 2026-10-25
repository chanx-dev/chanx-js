# @chanx-js/server

## 2.1.1

### Patch Changes

- 460ab29: List the supported runtimes in the package README: Node with ws, Express, Koa, Fastify, Hono, NestJS, Bun and Deno.

## 2.1.0

### Minor Changes

- 8bae122: Match chanx 2.12: a refused authentication closes with `4000 + status` (`4401`, `4403`, or `4500` when `authenticate` throws). AsyncAPI documents request and reply messages with a `ref` correlationId; a consumer's new `credentials` option becomes security schemes, operation security and a WebSocket binding; `servers` and `securitySchemes` options describe the rest. The docs page loads a pinned, hash-checked release of its assets, and the `docs` option points it at your own copies.

## 2.0.2

### Patch Changes

- e1abc6a: The package README says what the package is for, shows a working example, and links to the docs.
- Updated dependencies [e1abc6a]
  - @chanx-js/layers@2.0.1

## 2.0.1

### Patch Changes

- c797122: Depend on any compatible 2.x of `@chanx-js/layers` and `@chanx-js/server`, not only the exact version released alongside.
