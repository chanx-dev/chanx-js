import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelLayer, ChannelMessage, LayerOptions } from '../src';

/** Collects what a channel receives, so a test can wait for a count. */
export function inbox() {
  const messages: ChannelMessage[] = [];
  return {
    messages,
    handler: (message: ChannelMessage) => void messages.push(message),
    received: (count: number) => vi.waitFor(() => expect(messages).toHaveLength(count)),
  };
}

/** Behaviour every layer must share, whatever carries the messages. */
export function layerContract(
  name: string,
  makeLayer: (options: LayerOptions) => ChannelLayer,
) {
  describe(`${name}: layer contract`, () => {
    const onError = vi.fn();
    let layer: ChannelLayer;

    beforeEach(() => {
      onError.mockClear();
      layer = makeLayer({ onError });
    });
    afterEach(() => layer.flush());

    it('delivers a message sent to a channel', async () => {
      const box = inbox();
      const channel = await layer.newChannel(box.handler);

      await layer.send(channel.name, { type: 'chat.message', text: 'hi' });

      await box.received(1);
      expect(box.messages[0]).toEqual({ type: 'chat.message', text: 'hi' });
    });

    it('fans a group message out to every member, each with its own copy', async () => {
      const first = inbox();
      const second = inbox();
      const a = await layer.newChannel(first.handler);
      const b = await layer.newChannel(second.handler);
      await layer.groupAdd('room.lobby', a.name);
      await layer.groupAdd('room.lobby', b.name);

      await layer.groupSend('room.lobby', { type: 'room.event', nested: { n: 1 } });

      await first.received(1);
      await second.received(1);
      expect(first.messages[0]).toEqual(second.messages[0]);
      expect(first.messages[0]).not.toBe(second.messages[0]);
    });

    // Each negative check sends a marker after the message it rules out: delivery is in
    // order, so once the marker arrives, the message would have arrived before it.
    it('does not deliver from a group after discarding', async () => {
      const box = inbox();
      const channel = await layer.newChannel(box.handler);
      await layer.groupAdd('room.lobby', channel.name);
      await layer.groupDiscard('room.lobby', channel.name);

      await layer.groupSend('room.lobby', { type: 'room.event' });
      await layer.send(channel.name, { type: 'marker' });

      await box.received(1);
      expect(box.messages).toEqual([{ type: 'marker' }]);
    });

    it('keeps a group for the members still in it', async () => {
      const staying = inbox();
      const leaving = await layer.newChannel(() => {});
      const stays = await layer.newChannel(staying.handler);
      await layer.groupAdd('room.lobby', leaving.name);
      await layer.groupAdd('room.lobby', stays.name);
      await layer.groupDiscard('room.lobby', leaving.name);

      await layer.groupSend('room.lobby', { type: 'room.event' });

      await staying.received(1);
    });

    it('stops delivering to a closed channel, directly or through its groups', async () => {
      const closed = inbox();
      const witness = inbox();
      const channel = await layer.newChannel(closed.handler);
      const other = await layer.newChannel(witness.handler);
      await layer.groupAdd('room.lobby', channel.name);
      await layer.groupAdd('room.lobby', other.name);
      await channel.close();

      await layer.send(channel.name, { type: 'direct' });
      await layer.groupSend('room.lobby', { type: 'room.event' });

      await witness.received(1);
      expect(closed.messages).toHaveLength(0);
    });

    it('never runs a handler synchronously inside send()', async () => {
      const box = inbox();
      const channel = await layer.newChannel(box.handler);

      const sending = layer.send(channel.name, { type: 'direct' });
      expect(box.messages).toHaveLength(0);

      await sending;
      await box.received(1);
    });

    it('reports a throwing handler and keeps delivering to the others', async () => {
      const box = inbox();
      const failing = await layer.newChannel(() => {
        throw new Error('boom');
      });
      const rejecting = await layer.newChannel(async () => {
        throw new Error('async boom');
      });
      const healthy = await layer.newChannel(box.handler);
      for (const channel of [failing, rejecting, healthy]) {
        await layer.groupAdd('room.lobby', channel.name);
      }

      await layer.groupSend('room.lobby', { type: 'room.event' });

      await box.received(1);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    });

    it('keeps its methods working when destructured', async () => {
      const box = inbox();
      const { newChannel, send } = layer;
      const channel = await newChannel(box.handler);

      await send(channel.name, { type: 'direct' });

      await box.received(1);
    });

    it('only lets channels it created join a group', async () => {
      await expect(
        layer.groupAdd('room.lobby', 'asgispecific.elsewhere'),
      ).rejects.toThrow('created by this layer');
    });

    it('rejects names the Python layers would reject', async () => {
      const channel = await layer.newChannel(() => {});
      await expect(layer.groupAdd('room:lobby', channel.name)).rejects.toThrow(
        'Group name',
      );
      await expect(layer.groupSend('x'.repeat(100), {})).rejects.toThrow('Group name');
      await expect(layer.send('bad channel', {})).rejects.toThrow('Channel name');
    });

    it('forgets everything on flush, and works again afterwards', async () => {
      const stale = inbox();
      const channel = await layer.newChannel(stale.handler);
      await layer.groupAdd('room.lobby', channel.name);
      await layer.flush();

      const fresh = inbox();
      const again = await layer.newChannel(fresh.handler);
      await layer.groupAdd('room.lobby', again.name);
      await layer.groupSend('room.lobby', { type: 'room.event' });

      await fresh.received(1);
      expect(stale.messages).toHaveLength(0);
    });

    it('delivers again after leaving and rejoining a group', async () => {
      const box = inbox();
      const channel = await layer.newChannel(box.handler);
      await layer.groupAdd('room.lobby', channel.name);
      await Promise.all([
        layer.groupDiscard('room.lobby', channel.name),
        layer.groupAdd('room.lobby', channel.name),
      ]);

      await layer.groupSend('room.lobby', { type: 'room.event' });

      await box.received(1);
    });
  });
}
