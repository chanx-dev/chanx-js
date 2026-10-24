# Validation

Generated types check your code at compile time. Validation also checks messages at
runtime, against the schema the server published.

## Turning it on

Off by default: only types, with no runtime cost. `--validation zod` also emits `schemas.zod.ts` and attaches validators to each descriptor. The runtime only ever calls an optional hook, so zod is loaded only when you opt in. The generated file imports `zod`, so add it to your project (`pnpm add zod`, version 3.25 or later).

Validation is configured per client or per connection:

```ts
createClient({ validate: { outbound: true, inbound: false } });
```

The default validates outbound messages always (cheap, and it catches real bugs) and inbound messages only in development, where a token stream's cost does not matter. Development means `process.env.NODE_ENV` is not `production`, which Vite, webpack and Next.js all set at build time.

Validation checks a message and never changes it: your handlers get the message exactly as the server sent it, whether validation ran or not. An outbound message that fails throws from `send()`, since that is a bug at the call site. An inbound one that fails is reported (see [Receiving](/client/connections#receiving)) and not delivered.

## In services

A browser trusts its own server, but a service often talks to another team's. Validate
what arrives in production there too; see
[Node services and scripts](/client/integrations/node#trust-what-arrives).
