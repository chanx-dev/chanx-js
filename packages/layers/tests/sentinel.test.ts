import { createClient } from 'redis';
import { describe, expect, it, vi } from 'vitest';

import type { RedisSentinelHost } from '../src/redis';
import { RedisPubSubChannelLayer } from '../src/redis';
import { inbox, layerContract } from './contract';

// docker-compose.yml's Sentinel: it announces its nodes by hostname, published on these ports.
const sentinel = process.env.REDIS_SENTINEL;
const [sentinelHost = 'localhost', sentinelPort = '26379'] = sentinel?.split(':') ?? [];
const addresses: Record<string, { host: string; port: number }> = {
  'sentinel-master:6379': { host: sentinelHost, port: 6391 },
  'sentinel-replica:6379': { host: sentinelHost, port: 6392 },
};
const host: RedisSentinelHost = {
  sentinels: [{ host: sentinelHost, port: Number(sentinelPort) }],
  masterName: 'chanx',
  nodeAddressMap: addresses,
};
const layer = () =>
  new RedisPubSubChannelLayer({
    hosts: [host],
    prefix: 'chanxsentinel',
    onError: () => {},
  });

async function masterAddress(): Promise<string> {
  const client = createClient({
    socket: { host: sentinelHost, port: Number(sentinelPort) },
  });
  await client.connect();
  try {
    const reply = await client.sendCommand([
      'SENTINEL',
      'get-master-addr-by-name',
      'chanx',
    ]);
    return Array.isArray(reply) ? reply.join(':') : String(reply);
  } finally {
    await client.close();
  }
}

describe.skipIf(!sentinel)('RedisPubSubChannelLayer through Sentinel', () => {
  layerContract(
    'RedisPubSubChannelLayer, Sentinel',
    (options) =>
      new RedisPubSubChannelLayer({ ...options, hosts: [host], prefix: 'chanxsentinel' }),
  );

  it('keeps delivering after Sentinel fails over to the replica', async () => {
    const receiver = layer();
    const sender = layer();
    const box = inbox();
    try {
      const channel = await receiver.newChannel(box.handler);
      await receiver.groupAdd('room.failover', channel.name);
      await sender.groupSend('room.failover', { type: 'before' });
      await box.received(1);

      const before = await masterAddress();
      const admin = createClient({
        socket: { host: sentinelHost, port: Number(sentinelPort) },
      });
      await admin.connect();
      await admin.sendCommand(['SENTINEL', 'FAILOVER', 'chanx']);
      await admin.close();
      await vi.waitFor(async () => expect(await masterAddress()).not.toBe(before), {
        timeout: 15_000,
        interval: 250,
      });

      // A replica serves PUBLISH and SUBSCRIBE locally, so staying on the old master would
      // look fine end to end. Check each side against the new master directly.
      const master = createClient({
        socket: addresses[await masterAddress()],
      });
      const tap = master.duplicate();
      await Promise.all([master.connect(), tap.connect()]);
      const group = 'chanxsentinel__group__room.failover';
      let tapped = 0;
      try {
        await tap.subscribe(group, () => (tapped += 1));

        await vi.waitFor(
          async () => {
            await sender.groupSend('room.failover', { type: 'from-layer' });
            expect(tapped).toBeGreaterThan(0);
          },
          { timeout: 20_000, interval: 250 },
        );

        const direct = Buffer.from(await sender.serialize({ type: 'from-master' }));
        await vi.waitFor(
          async () => {
            await master.publish(group, direct);
            expect(box.messages).toContainEqual({ type: 'from-master' });
          },
          { timeout: 20_000, interval: 250 },
        );
      } finally {
        await Promise.all([master.close(), tap.close()]);
      }
    } finally {
      await Promise.all([sender.flush(), receiver.flush()]);
    }
  }, 45_000);
});
