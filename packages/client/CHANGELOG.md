# @chanx-js/client

## 2.3.2

### Patch Changes

- 43268f3: Say in the README that the package supports plain JavaScript as well as TypeScript.

## 2.3.1

### Patch Changes

- 91e6aa7: Point the repository, homepage and issue links at the chanx-dev org and the js.chanx.dev docs.

## 2.3.0

### Minor Changes

- f075cee: A socket closed with 4400 to 4499, a refused authentication, no longer reconnects by default; a server error (4500) still does. Pass `shouldReconnect` to choose otherwise.

## 2.2.1

### Patch Changes

- e1abc6a: The package README says what the package is for, shows a working example, and links to the docs.

## 2.2.0

### Minor Changes

- 56a8d42: A `headers` option, on `createClient()` or `connect()`, sends headers with the upgrade request from Node 22+, Bun and Deno, so a service authenticates without `ws`. Connections with different headers never share a socket, and a custom `socketFactory` receives them as a third argument.

### Patch Changes

- 56a8d42: An error thrown while opening a socket, such as no global `WebSocket`, is reported through `reportError` instead of being retried in silence.

## 2.1.0

### Minor Changes

- c489c24: `request()` resolves with the reply its action declares, such as `PongMessage` for `ping`, on connections, topic handles and every framework binding. Descriptors take the replies as an optional third type argument; without it, replies stay `ChanxMessage`.

### Patch Changes

- de61aa1: `connection.ready()` rejects once the socket gives up, is refused or is terminated, instead of waiting forever.
- 18ecacf: `for await` loops over a connection or topic end once the socket gives up reconnecting, instead of waiting forever.
