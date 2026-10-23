import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ChannelMessage } from '../src';
import { RedisPubSubChannelLayer } from '../src/redis';
import { createSerializer } from '../src/redis/serializer';
import { inbox } from './contract';

// The layer's Redis format, pinned: every process sharing the Redis reads and writes
// exactly this, so a change here breaks them even when both ends of this layer agree.
const MESSAGE: ChannelMessage = {
  type: 'chat.message',
  text: 'héllo ☕',
  n: 42,
  pi: 3.5,
  ok: true,
  none: null,
  list: [1, 'two', { three: 3 }],
  raw: new Uint8Array([0, 255, 16]),
};
// msgpack: a fixmap, str8 for strings, float64 for 3.5, bin8 for bytes.
const MSGPACK = hex(
  '88a474797065ac636861742e6d657373616765a474657874aa68c3a96c6c6f20e29895a16e2aa27069cb400c000000000000a26f6bc3a46e6f6e65c0a46c6973749301a374776f81a5746872656503a3726177c40300ff10',
);

function hex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g)!, (byte) => parseInt(byte, 16));
}

describe('message encoding', () => {
  it('encodes msgpack to these exact bytes', async () => {
    expect(await createSerializer().serialize(MESSAGE)).toEqual(MSGPACK);
  });

  it('decodes msgpack, bytes as Uint8Array', async () => {
    expect(await createSerializer().deserialize(MSGPACK)).toEqual(MESSAGE);
  });

  it('decodes JSON whose non-ASCII text is escaped', async () => {
    const json =
      '{"type": "chat.message", "text": "h\\u00e9llo \\u2615", "list": [1, {"three": 3}]}';
    const serializer = createSerializer({ format: 'json' });
    expect(await serializer.deserialize(new TextEncoder().encode(json))).toEqual({
      type: 'chat.message',
      text: 'héllo ☕',
      list: [1, { three: 3 }],
    });
  });
});

// A raw Redis client shares no code with the layer, so it sees only the format.
const url = process.env.REDIS_URL;
const url2 = process.env.REDIS_URL_2;

describe.skipIf(!url)('Redis channels', () => {
  const raw = createClient({ url: url! });
  const subscriber = raw.duplicate();
  beforeAll(() => Promise.all([raw.connect(), subscriber.connect()]));
  afterAll(() => Promise.all([raw.close(), subscriber.close()]));

  /** Subscribe now; the returned function waits for the first message. */
  const listen = async (client: typeof subscriber, channel: string) => {
    let resolve!: (data: Buffer) => void;
    const received = new Promise<Buffer>((done) => (resolve = done));
    await client.subscribe(channel, (data) => resolve(data), true);
    return async () => {
      const data = await received;
      await client.unsubscribe(channel);
      return new Uint8Array(data);
    };
  };

  it('names a new channel {prefix}specific.{32 hex}', async () => {
    const layer = new RedisPubSubChannelLayer({ hosts: [url!] });
    try {
      const channel = await layer.newChannel(() => {});
      expect(channel.name).toMatch(/^asgispecific\.[0-9a-f]{32}$/);
    } finally {
      await layer.flush();
    }
  });

  it('publishes a group message on {prefix}__group__{group}', async () => {
    const layer = new RedisPubSubChannelLayer({ hosts: [url!] });
    try {
      const received = await listen(subscriber, 'asgi__group__room.lobby');
      await layer.groupSend('room.lobby', MESSAGE);
      expect(await received()).toEqual(MSGPACK);
    } finally {
      await layer.flush();
    }
  });

  it('delivers what another client publishes to a channel and to a group', async () => {
    const layer = new RedisPubSubChannelLayer({ hosts: [url!] });
    const box = inbox();
    try {
      const channel = await layer.newChannel(box.handler);
      await layer.groupAdd('room.lobby', channel.name);

      await raw.publish(channel.name, Buffer.from(MSGPACK));
      await raw.publish('asgi__group__room.lobby', Buffer.from(MSGPACK));

      await box.received(2);
      expect(box.messages).toEqual([MESSAGE, MESSAGE]);
    } finally {
      await layer.flush();
    }
  });

  it.skipIf(!url2)('puts each group on the host its CRC-32 picks', async () => {
    const second = createClient({ url: url2! });
    await second.connect();
    const layer = new RedisPubSubChannelLayer({ hosts: [url!, url2!] });
    try {
      // crc32 % 2: room.lobby on the first host, room.h on the second.
      const onFirst = await listen(subscriber, 'asgi__group__room.lobby');
      const onSecond = await listen(second, 'asgi__group__room.h');
      await layer.groupSend('room.lobby', { type: 'first' });
      await layer.groupSend('room.h', { type: 'second' });

      const { deserialize } = createSerializer();
      expect(await deserialize(await onFirst())).toEqual({ type: 'first' });
      expect(await deserialize(await onSecond())).toEqual({ type: 'second' });
    } finally {
      await layer.flush();
      await second.close();
    }
  });
});
