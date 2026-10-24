# Python and Node together

chanx-js speaks the same protocol as [chanx](https://github.com/huynguyengl99/chanx) on
Django Channels and FastAPI, and its Redis layer writes the same bytes. So the two mix
at every level: one client for either server, and Node and Python servers in one
deployment.

## One client for either server

A chanx server documents itself as AsyncAPI, whichever language it runs in. Point the
generator at a Python server exactly as at a Node one:

```bash
npx chanx-codegen https://api.example.com/asyncapi.json
```

The generated channels, topics and heartbeat work the same. Two version notes: plain
channel `request()` needs chanx 2.11.2 or later, the first release to echo the `ref` on
replies, and a 2.x client works with any 2.x server.

## Node and Python servers on one Redis

Give both sides the Redis channel layer with the same settings, and a broadcast from one
reaches connections on the other:

```ts
// Node
new RedisPubSubChannelLayer({ hosts: ['redis://redis:6379'], prefix: 'asgi' });
```

```python
# Python (channels_redis or fast-channels)
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.pubsub.RedisPubSubChannelLayer",
        "CONFIG": {"hosts": ["redis://redis:6379"], "prefix": "asgi"},
    }
}
```

The settings that must match, `hosts` in the same order included, are listed under
[Sharing Redis with Python](/server/layers#sharing-redis-with-python).

What crosses between them:

- **Groups.** A group is a name, such as `room.lobby`. A Python consumer's
  `broadcast_event` to it reaches Node connections in it, and the other way round.
- **Events.** An event handled on both sides needs the same action and payload shape on
  both. Define it once per side, and let a test pin the shape.
- **Topics.** A topic's subscribers form a group named after its class, such as
  `RoomTopic.room-lobby`, so a publish from either side reaches both only when the topic
  has the same name on both. Set `name` on a builder topic to match the Python class.

## Moving a service across

Because the wire format is shared, a move can go one consumer at a time. Serve the new
Node consumer on the same path, route that path to the Node server at your proxy, and
keep both on one Redis. Clients notice nothing: the frames, errors and AsyncAPI are the
same, so the generated client does not even change.

## Differences to know

- **Numbers.** JavaScript has one number type. A whole-number float such as `1.0` arrives
  in Python as an int.
- **Bytes.** msgpack, the default serializer, carries bytes (`Uint8Array` in Node); the
  JSON serializer does not.
- **Validation messages.** Errors keep pydantic's shape and locations, but the `msg` text
  comes from your schema library, so branch on `type` and `loc`, not the wording.
