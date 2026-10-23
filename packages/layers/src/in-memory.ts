import { LAYER_METHODS, bindMethods } from './bind';
import { LocalChannels } from './channels';
import { assertChannelName, assertGroupName } from './names';
import type {
  ChannelLayer,
  ChannelMessage,
  LayerChannel,
  LayerOptions,
  MessageHandler,
} from './types';

/** A single-process layer, for development and tests. */
export class InMemoryChannelLayer implements ChannelLayer {
  readonly #local: LocalChannels;

  constructor(options: LayerOptions = {}) {
    this.#local = new LocalChannels(options);
    bindMethods(this, LAYER_METHODS);
  }

  async newChannel(
    handler: MessageHandler,
    { prefix = 'specific.' }: { prefix?: string } = {},
  ): Promise<LayerChannel> {
    const name = `${prefix}inmemory!${crypto.randomUUID().replaceAll('-', '')}`;
    assertChannelName(name);
    this.#local.handlers.set(name, handler);
    return {
      name,
      close: async () => {
        this.#local.remove(name);
      },
    };
  }

  // Delivered later and copied, as a real layer delivers after a round trip.
  async send(channel: string, message: ChannelMessage): Promise<void> {
    assertChannelName(channel);
    const copy = structuredClone(message);
    queueMicrotask(() => this.#local.deliver(channel, copy));
  }

  async groupAdd(group: string, channel: string): Promise<void> {
    assertGroupName(group);
    this.#local.requireLocal(channel);
    this.#local.join(group, channel);
  }

  async groupDiscard(group: string, channel: string): Promise<void> {
    assertGroupName(group);
    this.#local.leave(group, channel);
  }

  async groupSend(group: string, message: ChannelMessage): Promise<void> {
    assertGroupName(group);
    const copy = structuredClone(message);
    queueMicrotask(() => this.#local.deliverToGroup(group, copy));
  }

  async flush(): Promise<void> {
    this.#local.clear();
  }
}
