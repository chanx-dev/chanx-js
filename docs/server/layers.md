# Channel layers

A channel layer carries groups and events between processes, so a broadcast reaches
every server and worker, not only the one that sent it. `@chanx-js/layers` provides two.

## In memory

`InMemoryChannelLayer` works within one process: the default when `createChanx()` is given
no layers. Enough for development, tests and a single server.

## Redis

`RedisPubSubChannelLayer` from `@chanx-js/layers/redis` uses Redis pub/sub, through
the official [node-redis](https://github.com/redis/node-redis) client:

::: code-group

```bash [pnpm]
pnpm add @chanx-js/layers redis
```

```bash [npm]
npm install @chanx-js/layers redis
```

:::

```ts
import { RedisPubSubChannelLayer } from '@chanx-js/layers/redis';

const chanx = createChanx({
  consumers: [chat],
  layers: {
    default: new RedisPubSubChannelLayer({
      hosts: [process.env.REDIS_URL!],
    }),
  },
});
```

Each host is a Redis URL, or node-redis client options for TLS and auth. With several
hosts, channels and groups are spread across them by a CRC-32 hash.

Delivery is at most once, as with any pub/sub: a message published while nobody is
subscribed is gone.

## Redis Sentinel

A host can be a Sentinel instead of a server: the layer asks the sentinels for the
current master, and follows it when Sentinel fails over.

```ts
new RedisPubSubChannelLayer({
  hosts: [
    {
      sentinels: [{ host: 'sentinel-1', port: 26379 }],
      masterName: 'mymaster',
    },
  ],
});
```

It mirrors Python's Sentinel host, with the same master on both sides:

```python
{"sentinels": [("sentinel-1", 26379)], "master_name": "mymaster"}
```

The rest are node-redis Sentinel options: `nodeClientOptions` for the password or TLS to
the Redis servers, `sentinelClientOptions` for the sentinels', and `nodeAddressMap` when
the sentinels report addresses the client cannot reach, as from inside Docker. Neither
Python layer supports Redis Cluster, so neither does this one.

## Several layers

Name layers in `createChanx({ layers })`, then pick one per consumer or topic with its
`layer` option. Unnamed, they use `default`.

```ts
createChanx({
  consumers: [chat, metrics],
  layers: {
    default: redisLayer,
    local: new InMemoryChannelLayer(),
  },
});

consumer('/ws/metrics', { name: 'metrics', layer: 'local' });
```

## Sharing Redis with Python

The Redis layer is wire-compatible with `RedisPubSubChannelLayer` from Python's
[channels_redis](https://github.com/django/channels_redis) and
[fast-channels](https://github.com/huynguyengl99/fast-channels). The messages chanx
puts on it are chanx's own, so a Python worker's `broadcast_event` reaches Node
connections, and the other way round. Use the same settings on both sides:

| Node                      | Python                      | Default            |
| ------------------------- | --------------------------- | ------------------ |
| `hosts` (same order)      | `hosts`                     | `localhost:6379`   |
| `prefix`                  | `prefix`                    | `asgi`             |
| `serializerFormat`        | `serializer_format`         | `msgpack`          |
| `symmetricEncryptionKeys` | `symmetric_encryption_keys` | none (unencrypted) |

msgpack carries bytes (`Uint8Array` in Node); JSON does not. A whole-number JS float
such as `1.0` arrives in Python as an int.

## Using a layer directly

A layer works without chanx. Its operations are Python's, camelCased, and deliver
through a handler instead of `receive()`:

```ts
const channel = await layer.newChannel((message) =>
  console.log(message),
);
await layer.groupAdd('room.lobby', channel.name);
await layer.groupSend('room.lobby', {
  type: 'chat.message',
  text: 'hi',
});
await channel.close();
```

Handler errors go to the `onError` option (default `console.error`). To change the wire
format, subclass `RedisPubSubChannelLayer` and override `serialize` and `deserialize`.
