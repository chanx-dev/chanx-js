# Consumers

A consumer is one WebSocket route: the messages it accepts, what it sends back, and
what happens when a client connects and leaves. Write it with the `consumer()` builder
or as a class; both produce the same consumer.

## Handlers and replies

`.on(Message, handler)` handles a client message. Declare an `output` and return it to
reply; the reply carries the request's `ref`, so the client matches it to the request.

```ts
const chat = consumer('/ws/chat/{room}', { name: 'chat' })
  .on(PingMessage, { output: PongMessage }, () =>
    PongMessage.create(),
  )
  .on(History, { output: HistoryResult }, async (_m, ctx) =>
    HistoryResult.create(await loadHistory(ctx.params.room)),
  );
```

`output` takes one message or a list. In development, returning anything undeclared
logs a warning. Each action may have one handler per consumer.

What else a handler can do through `ctx`:

| `ctx`         | What it does                                                  |
| ------------- | ------------------------------------------------------------- |
| `send(msg)`   | Send on this connection, with the frame's `ref`.              |
| `push(msg)`   | Send as a server push, without a `ref`.                       |
| `broadcast()` | Send to every connection in the groups, across processes.     |
| `params`      | Path params: `/ws/chat/{room}` gives `room`.                  |
| `state`       | Per-connection state, from the `state` option.                |
| `conn`        | The connection: `user`, `groups`, `join()`, `leave()`, ...    |
| `signal`      | Aborts when the connection closes, to stop long-running work. |

Messages a handler sends without returning them belong in `emits`, so they are
documented and typed:

```ts
consumer('/ws/chat/{room}', { name: 'chat', emits: [Notice] });
```

## Per-connection state

`state` builds an object for each connection, available as `ctx.state`:

```ts
consumer('/ws/game', {
  name: 'game',
  state: (conn) => ({ score: 0, joinedAt: Date.now() }),
}).on(Score, (m, ctx) => {
  ctx.state.score += m.payload.points;
});
```

## Authentication

`authenticate` runs once the socket is accepted. Return the user, or `false` to reject:

```ts
consumer('/ws/chat/{room}', {
  name: 'chat',
  authenticate: async ({ headers, url }) =>
    (await userFromToken(url.searchParams.get('token'))) ?? false,
  onConnect: (ctx) => console.log(`${ctx.conn.user.name} joined`),
});
```

The client always gets an `authentication` message: status 200 on success, 401 when
`authenticate` returns `false`, `null` or `undefined`, then the socket closes. Throw an
`AuthenticationError` to choose the status and data:

```ts
throw new AuthenticationError({
  status: 403,
  statusText: 'Forbidden',
  data: { detail: 'Banned' },
});
```

This is chanx's flow: the socket is accepted first, so a browser client can read why it
was refused. `onConnect` runs once authenticated and the groups are joined;
`onDisconnect` runs when the socket closes, before the groups are left.

### Refusing before the upgrade

`rejectBeforeUpgrade: true` runs `authenticate` before the socket is accepted, and
refuses with an HTTP status instead: 401, or an `AuthenticationError`'s status, with the
`authentication` message's data as a JSON body; 500 when `authenticate` throws. A
successful client still gets the `authentication` message.

```ts
consumer('/ws/ingest', {
  name: 'ingest',
  authenticate: byApiKey,
  rejectBeforeUpgrade: true,
});
```

Use it for server-to-server clients, or to hold no socket for anonymous traffic. Not for
browsers: a browser's `WebSocket` sees only that the connection failed, never why, and
`@chanx-js/client` keeps retrying. On `@hono/node-server` the refusal carries its status
but no body. The in-process test client always accepts first; call `chanx.upgrade()` to
test a refusal.

## Groups and broadcasts

Connections join groups, and a broadcast reaches every connection in them, in every
process sharing the [channel layer](/server/layers).

```ts
consumer('/ws/room/{name}', {
  name: 'room',
  emits: [Said],
  groups: (conn) => [`room.${conn.params.name}`],
}).on(Say, (m, ctx) =>
  ctx.broadcast(Said.create(m.payload), { excludeCurrent: true }),
);
```

`groups` is a list, or a function of the connection. To join or leave later, such as
when a client asks to join a room, call `ctx.conn.join(group)` and
`ctx.conn.leave(group)`.

## Events from anywhere

An event is a message from the server side: a request handler, a worker, another
process. `.event()` handles one; its declared `output` goes to the client.
`.passthrough()` forwards events to the client unchanged.

```ts
const room = consumer('/ws/room/{name}', {
  name: 'room',
  groups: ['everyone'],
})
  .event(UserJoined, { output: JoinedNotice }, (e) =>
    JoinedNotice.create({ text: `${e.payload.user} joined` }),
  )
  .passthrough(Alert);

// In a route handler, a job, anywhere:
await chanx.broadcastEvent(
  room,
  UserJoined.create({ user: 'ann' }),
);
await chanx.sendEvent(
  room,
  Alert.create({ text: 'hi' }),
  channelName,
);
```

`broadcastEvent` goes to the consumer's groups, or to the groups you pass.
`sendEvent` goes to one connection, by its `ctx.conn.channelName`. Both accept only the
events the consumer handles.

## Reusable handlers

`handlers()` builds a set of handlers to mount on several consumers with `.use()`. Its
type parameter states the state it needs, and `.use()` checks the consumer has it:

```ts
const presence = handlers<{ room: RoomService }>().on(
  Who,
  (_m, ctx) => ctx.send(Present.create(ctx.state.room.members())),
);

consumer('/ws/room/{name}', {
  name: 'room',
  state: (conn) => ({ room: new RoomService(conn.params.name) }),
}).use(presence);
```

## Errors

Failures reach the client as chanx sends them:

- A frame that fails validation gets an `error` frame listing the issues, in the shape
  of pydantic's errors (`type`, `loc`, `msg`).
- A handler that throws is logged, and the client gets an `error` naming the action.
- An event handler that throws is logged; the client is told nothing.

Override any of them per consumer:

```ts
consumer('/ws/chat', {
  name: 'chat',
  onValidationError: (issues, ctx) =>
    ctx.send(Problem.create({ issues })),
  onHandlerError: (error, message, ctx) => report(error),
  onEventError: (error, event, ctx) => report(error),
});
```

## Classes

The same consumer can be a class instead, for shared logic, base classes and hooks to
override. See [Classes](/server/classes).
