# @chanx-js/layers

Channel layers for Node: groups and messaging across processes, so a broadcast reaches
every server and worker, not only the one that sent it.

**[Documentation](https://huynguyengl99.github.io/chanx-js/server/layers)** · [chanx-js](https://huynguyengl99.github.io/chanx-js/) ·
[Why chanx-js?](https://huynguyengl99.github.io/chanx-js/introduction/why)

The Redis layer is wire-compatible with `RedisPubSubChannelLayer` from Python's
[channels_redis](https://github.com/django/channels_redis) and
[fast-channels](https://github.com/huynguyengl99/fast-channels): Python and Node
processes can share one Redis.

```ts
import { RedisPubSubChannelLayer } from '@chanx-js/layers/redis';

const layer = new RedisPubSubChannelLayer({ hosts: ['redis://localhost:6379'] });

const channel = await layer.newChannel((message) => console.log(message));
await layer.groupAdd('room.lobby', channel.name);
await layer.groupSend('room.lobby', { type: 'chat.message', text: 'hi' });
```

`new InMemoryChannelLayer()` from `@chanx-js/layers` does the same within one process,
for development and tests. Both are named after their Python counterparts.

## Sharing Redis with Python

Use the same settings on both sides:

| Node                      | Python                      | Default            |
| ------------------------- | --------------------------- | ------------------ |
| `hosts` (same order)      | `hosts`                     | `localhost:6379`   |
| `prefix`                  | `prefix`                    | `asgi`             |
| `serializerFormat`        | `serializer_format`         | `msgpack`          |
| `symmetricEncryptionKeys` | `symmetric_encryption_keys` | none (unencrypted) |

Messages are dicts on the Python side. msgpack carries bytes (`Uint8Array` in Node);
JSON does not. A whole-number JS float such as `1.0` arrives in Python as an int.

Delivery is at most once, as with Python's pub/sub layer: a message published while
nobody is subscribed is gone.

## API

Python's operations, camelCased, delivering through a handler instead of `receive()`:
`newChannel(handler)`, `send`, `groupAdd`, `groupDiscard`, `groupSend`, `flush`, and
`channel.close()`. Handler errors go to the `onError` option (default `console.error`).
Methods are bound, so they can be passed around. To change the wire format, subclass
`RedisPubSubChannelLayer` and override `serialize` and `deserialize`, as in Python.
