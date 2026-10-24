---
'@chanx-js/client': minor
---

A `headers` option, on `createClient()` or `connect()`, sends headers with the upgrade request from Node 22+, Bun and Deno, so a service authenticates without `ws`. Connections with different headers never share a socket, and a custom `socketFactory` receives them as a third argument.
