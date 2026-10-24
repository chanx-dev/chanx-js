import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RedisPubSubChannelLayer } from '../src/redis';
import { consistentHash } from '../src/redis/hash';
import type { ChannelMessage } from '../src';
import { inbox, layerContract } from './contract';
import { redisProxy } from './proxy';

const url = process.env.REDIS_URL;
const url2 = process.env.REDIS_URL_2;

describe.skipIf(!url)('RedisPubSubChannelLayer', () => {
  layerContract(
    'RedisPubSubChannelLayer',
    (options) =>
      new RedisPubSubChannelLayer({ ...options, hosts: [url!], prefix: 'chanxtest' }),
  );

  layerContract(
    'RedisPubSubChannelLayer, encrypted JSON',
    (options) =>
      new RedisPubSubChannelLayer({
        ...options,
        hosts: [url!],
        prefix: 'chanxtest',
        serializerFormat: 'json',
        symmetricEncryptionKeys: ['secret'],
      }),
  );

  it('crosses processes: one layer instance reaches another', async () => {
    const sender = new RedisPubSubChannelLayer({ hosts: [url!], prefix: 'chanxtest' });
    const receiver = new RedisPubSubChannelLayer({ hosts: [url!], prefix: 'chanxtest' });
    const box = inbox();
    try {
      const channel = await receiver.newChannel(box.handler);
      await receiver.groupAdd('room.lobby', channel.name);

      await sender.groupSend('room.lobby', { type: 'room.event', n: 1 });
      await sender.send(channel.name, { type: 'direct', n: 2 });

      await box.received(2);
      expect(box.messages).toEqual(
        expect.arrayContaining([
          { type: 'room.event', n: 1 },
          { type: 'direct', n: 2 },
        ]),
      );
    } finally {
      await Promise.all([sender.flush(), receiver.flush()]);
    }
  });

  it("uses a subclass's serializer on both ends", async () => {
    class Reversed extends RedisPubSubChannelLayer {
      override async serialize(message: ChannelMessage) {
        return new TextEncoder().encode(
          JSON.stringify(message).split('').reverse().join(''),
        );
      }
      override async deserialize(data: Uint8Array) {
        return JSON.parse(new TextDecoder().decode(data).split('').reverse().join(''));
      }
    }
    const layer = new Reversed({ hosts: [url!] });
    const box = inbox();
    try {
      const channel = await layer.newChannel(box.handler);
      await layer.send(channel.name, { type: 'direct', text: 'abc' });

      await box.received(1);
      expect(box.messages[0]).toEqual({ type: 'direct', text: 'abc' });
      expect(layer).toBeInstanceOf(RedisPubSubChannelLayer);
    } finally {
      await layer.flush();
    }
  });

  it('delivers bytes as a plain Uint8Array', async () => {
    const layer = new RedisPubSubChannelLayer({ hosts: [url!] });
    const box = inbox();
    try {
      const channel = await layer.newChannel(box.handler);
      await layer.send(channel.name, { type: 'blob', raw: new Uint8Array([0, 255]) });

      await box.received(1);
      expect(box.messages[0]!.raw).toStrictEqual(new Uint8Array([0, 255]));
    } finally {
      await layer.flush();
    }
  });

  it('keeps the order messages were published in, even when decoding takes longer', async () => {
    const layer = new RedisPubSubChannelLayer({
      hosts: [url!],
      symmetricEncryptionKeys: ['secret'],
    });
    const box = inbox();
    try {
      const channel = await layer.newChannel(box.handler);
      // Large and tiny messages alternate, so a tiny one would finish decrypting first.
      for (let n = 0; n < 20; n++) {
        await layer.send(channel.name, {
          type: 'tick',
          n,
          pad: n % 2 ? '' : 'x'.repeat(500_000),
        });
      }

      await box.received(20);
      expect(box.messages.map((message) => message.n)).toEqual([...Array(20).keys()]);
    } finally {
      await layer.flush();
    }
  });

  it('reports a message it cannot decrypt instead of delivering it', async () => {
    const errors: unknown[] = [];
    const receiver = new RedisPubSubChannelLayer({
      hosts: [url!],
      symmetricEncryptionKeys: ['right'],
      onError: (error) => errors.push(error),
    });
    const sender = new RedisPubSubChannelLayer({
      hosts: [url!],
      symmetricEncryptionKeys: ['wrong'],
    });
    const box = inbox();
    try {
      const channel = await receiver.newChannel(box.handler);
      await sender.send(channel.name, { type: 'secret' });

      await expect.poll(() => errors).toHaveLength(1);
      expect(box.messages).toHaveLength(0);
    } finally {
      await Promise.all([sender.flush(), receiver.flush()]);
    }
  });

  describe('checked against Redis itself', () => {
    let admin: ReturnType<typeof createClient>;
    beforeAll(async () => {
      admin = createClient({ url: url! });
      await admin.connect();
    });
    afterAll(() => admin.close());
    const subscribers = async (channel: string) =>
      (await admin.pubSubNumSub(channel))[channel];

    it('resolves a second groupAdd only once Redis has the subscription', async () => {
      const layer = new RedisPubSubChannelLayer({ hosts: [url!], prefix: 'chanxtest' });
      try {
        const a = await layer.newChannel(() => {});
        const b = await layer.newChannel(() => {});
        const joining = layer.groupAdd('room.live', a.name);
        await layer.groupAdd('room.live', b.name);

        expect(await subscribers('chanxtest__group__room.live')).toBe(1);
        await joining;
      } finally {
        await layer.flush();
      }
    });

    it('leaves no subscription behind when a join and a leave race', async () => {
      const layer = new RedisPubSubChannelLayer({ hosts: [url!], prefix: 'chanxtest' });
      try {
        const channel = await layer.newChannel(() => {});
        await Promise.all([
          layer.groupAdd('room.race', channel.name),
          layer.groupDiscard('room.race', channel.name),
        ]);

        expect(await subscribers('chanxtest__group__room.race')).toBe(0);
      } finally {
        await layer.flush();
      }
    });

    it('unsubscribes from the groups a closed channel leaves empty', async () => {
      const layer = new RedisPubSubChannelLayer({ hosts: [url!], prefix: 'chanxtest' });
      try {
        const channel = await layer.newChannel(() => {});
        await layer.groupAdd('room.closing', channel.name);
        await channel.close();

        expect(await subscribers('chanxtest__group__room.closing')).toBe(0);
        expect(await subscribers(channel.name)).toBe(0);
      } finally {
        await layer.flush();
      }
    });

    it('does not keep a channel in a group whose join failed', async () => {
      const proxy = await redisProxy(url!);
      const layer = new RedisPubSubChannelLayer({
        hosts: [url!, { url: proxy.url, socket: { reconnectStrategy: false } }],
        prefix: 'chanxtest',
        onError: () => {},
      });
      const failed = inbox();
      const joined = inbox();
      try {
        // Channels on the direct host, a group behind the proxy, refusing until the second join.
        proxy.refuse = () => true;
        const onDirectHost = async (handler: (message: ChannelMessage) => void) => {
          for (;;) {
            const channel = await layer.newChannel(handler).catch(() => undefined);
            if (channel && consistentHash(channel.name, 2) === 0) return channel;
          }
        };
        const a = await onDirectHost(failed.handler);
        const b = await onDirectHost(joined.handler);
        const group = Array.from({ length: 100 }, (_, index) => `room.${index}`).find(
          (name) => consistentHash(`chanxtest__group__${name}`, 2) === 1,
        )!;

        await expect(layer.groupAdd(group, a.name)).rejects.toThrow();
        proxy.refuse = () => false;
        await layer.groupAdd(group, b.name);
        await layer.groupSend(group, { type: 'room.event' });

        await joined.received(1);
        expect(failed.messages).toHaveLength(0);
      } finally {
        await layer.flush();
        await proxy.close();
      }
    });

    it('flushes cleanly while a connection attempt is failing', async () => {
      const proxy = await redisProxy(url!);
      proxy.refuse = () => true;
      const layer = new RedisPubSubChannelLayer({
        hosts: [{ url: proxy.url, socket: { reconnectStrategy: false } }],
        onError: () => {},
      });
      try {
        const sending = layer.send('asgispecific.x', { type: 'direct' });
        await expect(layer.flush()).resolves.toBeUndefined();
        await expect(sending).rejects.toThrow();
      } finally {
        await proxy.close();
      }
    });

    it('closes the connection that opened when its partner failed', async () => {
      const proxy = await redisProxy(url!);
      proxy.refuse = (attempt) => attempt === 2;
      const layer = new RedisPubSubChannelLayer({
        hosts: [{ url: proxy.url, socket: { reconnectStrategy: false } }],
        onError: () => {},
      });
      try {
        await expect(layer.send('asgispecific.x', { type: 'direct' })).rejects.toThrow();
        await vi.waitFor(() => expect(proxy.open).toBe(0));
      } finally {
        await layer.flush();
        await proxy.close();
      }
    });
  });

  it.skipIf(!url2)('shards channels and groups across hosts', async () => {
    const hosts = [url!, url2!];
    const sender = new RedisPubSubChannelLayer({ hosts });
    const receiver = new RedisPubSubChannelLayer({ hosts });
    const box = inbox();
    try {
      const groups = Array.from({ length: 8 }, (_, index) => `room.${index}`);
      const channel = await receiver.newChannel(box.handler);
      for (const group of groups) await receiver.groupAdd(group, channel.name);

      for (const group of groups)
        await sender.groupSend(group, { type: 'room.event', group });

      await box.received(groups.length);
    } finally {
      await Promise.all([sender.flush(), receiver.flush()]);
    }
  });
});

describe.skipIf(!url)('RedisPubSubChannelLayer when its connection drops', () => {
  it('reconnects and keeps its subscriptions, as after a Redis restart', async () => {
    const proxy = await redisProxy(url!);
    const receiver = new RedisPubSubChannelLayer({
      hosts: [{ url: proxy.url, socket: { reconnectStrategy: () => 50 } }],
      prefix: 'chanxtest',
      onError: () => {},
    });
    const sender = new RedisPubSubChannelLayer({ hosts: [url!], prefix: 'chanxtest' });
    const box = inbox();
    try {
      const channel = await receiver.newChannel(box.handler);
      await receiver.groupAdd('room.restart', channel.name);
      await sender.groupSend('room.restart', { type: 'before' });
      await box.received(1);

      const opened = proxy.attempts;
      proxy.drop();
      await vi.waitFor(() => expect(proxy.attempts).toBeGreaterThan(opened));

      // Publish until a message lands: the resubscribe races the first sends.
      await vi.waitFor(
        async () => {
          await sender.groupSend('room.restart', { type: 'after' });
          expect(box.messages).toContainEqual({ type: 'after' });
        },
        { timeout: 5000, interval: 100 },
      );
      await sender.send(channel.name, { type: 'direct' });
      await vi.waitFor(() => expect(box.messages).toContainEqual({ type: 'direct' }));
    } finally {
      await Promise.all([sender.flush(), receiver.flush()]);
      await proxy.close();
    }
  });
});

describe('RedisPubSubChannelLayer when Redis is unreachable', () => {
  it('rejects, then connects afresh on the next call instead of caching the failure', async () => {
    let attempts = 0;
    const server = createServer((socket) => {
      attempts += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const layer = new RedisPubSubChannelLayer({
      hosts: [{ url: `redis://127.0.0.1:${port}`, socket: { reconnectStrategy: false } }],
      onError: () => {},
    });

    try {
      await expect(layer.send('asgispecific.x', { type: 'direct' })).rejects.toThrow();
      const first = attempts;
      await expect(layer.send('asgispecific.x', { type: 'direct' })).rejects.toThrow();

      expect(first).toBeGreaterThan(0);
      expect(attempts).toBeGreaterThan(first);
    } finally {
      await layer.flush();
      server.close();
    }
  });
});
