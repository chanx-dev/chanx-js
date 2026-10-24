# Testing

`@chanx-js/server/testing` connects to an app in-process, without a network or a port.

## The test client

```ts
import { connect } from '@chanx-js/server/testing';

const client = connect(chanx, '/ws/chat/lobby?token=ok');
expect(await client.ready).toBe(true);

const pong = await client.request({ action: 'ping' });
expect(pong).toMatchObject({ action: 'pong' });
```

Pass `{ headers }` as a third argument to test a consumer that authenticates by header:
`connect(chanx, '/ws/ingest', { headers: { authorization: 'Bearer key' } })`.

| Method                      | What it does                                              |
| --------------------------- | --------------------------------------------------------- |
| `ready`                     | Resolves once connected; `false` if refused.              |
| `send(frame)`               | Send a raw frame, as it goes on the wire.                 |
| `sendMessage(msg, options)` | Send a message from `.create()`, with a `topic` or `ref`. |
| `request(msg, { topic })`   | Send with a fresh `ref`; resolves with the reply.         |
| `receive()`                 | The next frame.                                           |
| `receiveUntil(action)`      | Frames until one with this action, that one included.     |
| `receiveAll()`              | Every frame until the server goes quiet.                  |
| `receiveNothing()`          | Whether no frame arrives.                                 |
| `subscribe(topic)`          | Subscribe; resolves with the reply.                       |
| `unsubscribe(topic)`        | Unsubscribe; resolves with the reply.                     |
| `close()`                   | Close; resolves once the server tore the connection down. |
| `closed`                    | Resolves with `{ code, reason }` when the server closes.  |

`receive` and `request` wait up to a second, `receiveAll` and `receiveNothing` 100 ms;
pass `{ timeout }` to change it.

## Capturing broadcasts

To check what was sent, rather than what a second client received, capture it. A
capture records without delivering unless given `{ suppress: false }`:

```ts
import {
  captureBroadcastEvents,
  captureTopicBroadcasts,
} from '@chanx-js/server/testing';

const posts = captureTopicBroadcasts(chanx, roomTopic);
await client.request(
  { action: 'post', payload: { body: 'hi' } },
  { topic: 'room:lobby' },
);

expect(posts.captured).toEqual([
  {
    topic: 'room:lobby',
    event: RoomEvent.create({ body: 'hi' }),
    seq: undefined,
  },
]);
posts.restore();
```

- `captureBroadcastEvents(chanx, consumer)` records `chanx.broadcastEvent()` calls,
  with the groups passed.
- `captureTopicBroadcasts(chanx, topic)` records publishes to a topic, from handlers'
  `ctx.publish()` as well as `chanx.publish()`.

`restore()` stops capturing.
