/**
 * A Redis pub/sub layer, wire-compatible with Python's.
 *
 * @module redis
 */
import type { RedisClientOptions, RedisSentinelOptions } from 'redis';
import { createClient, createSentinel } from 'redis';

import { LocalChannels } from '../channels';
import { assertChannelName, assertGroupName } from '../names';
import { LAYER_METHODS, bindMethods } from '../bind';
import type {
  ChannelLayer,
  ChannelMessage,
  LayerChannel,
  LayerOptions,
  MessageHandler,
} from '../types';
import { consistentHash } from './hash';
import type { Serializer, SerializerFormat, SerializerOptions } from './serializer';
import { createSerializer } from './serializer';

export { InvalidToken } from './fernet';
export type { SerializerFormat } from './serializer';

/** A Redis URL, node-redis client options for TLS, auth and the rest, or a Sentinel. */
export type RedisHost = string | RedisClientOptions | RedisSentinelHost;

/**
 * A master found through Redis Sentinel, as Python's `{"sentinels": [...], "master_name": ...}`
 * host. The rest are node-redis Sentinel options, such as `nodeClientOptions` for auth.
 */
export interface RedisSentinelHost extends Omit<
  RedisSentinelOptions,
  'name' | 'sentinelRootNodes'
> {
  sentinels: Array<{ host: string; port: number }>;
  masterName: string;
}

export interface RedisPubSubChannelLayerOptions extends LayerOptions {
  /** Shards, in the same order as the Python side's `hosts`. */
  hosts?: RedisHost[];
  prefix?: string;
  serializerFormat?: SerializerFormat;
  symmetricEncryptionKeys?: SerializerOptions['symmetricEncryptionKeys'];
}

/**
 * Redis pub/sub layer, wire-compatible with `RedisPubSubChannelLayer` from
 * channels_redis and fast-channels: Python and Node processes can share it.
 */
export class RedisPubSubChannelLayer implements ChannelLayer {
  readonly prefix: string;
  readonly #local: LocalChannels;
  readonly #serializer: Serializer;
  readonly #shards: Shard[];
  // Decoding is async; chaining keeps messages in the order Redis delivered them.
  #inbox = Promise.resolve();

  constructor(options: RedisPubSubChannelLayerOptions = {}) {
    const { hosts = ['redis://localhost:6379'], prefix = 'asgi' } = options;
    this.prefix = prefix;
    this.#local = new LocalChannels(options);
    this.#serializer = createSerializer({
      format: options.serializerFormat,
      symmetricEncryptionKeys: options.symmetricEncryptionKeys,
    });
    this.#shards = hosts.map(
      (host) =>
        new Shard(
          host,
          (data, name) => this.#receive(data, name),
          (error) => this.#local.report(error),
        ),
    );
    bindMethods(this, [...LAYER_METHODS, 'serialize', 'deserialize']);
  }

  /** Message to bytes on the wire. Override to change the format on both ends. */
  serialize(message: ChannelMessage): Promise<Uint8Array> {
    return this.#serializer.serialize(message);
  }

  deserialize(data: Uint8Array): Promise<ChannelMessage> {
    return this.#serializer.deserialize(data);
  }

  async newChannel(
    handler: MessageHandler,
    { prefix = 'specific.' }: { prefix?: string } = {},
  ): Promise<LayerChannel> {
    const name = `${this.prefix}${prefix}${crypto.randomUUID().replaceAll('-', '')}`;
    assertChannelName(name);
    // Nobody knows the name until we return it, so nothing can arrive before this.
    await this.#shardFor(name).subscribe(name);
    this.#local.handlers.set(name, handler);
    return {
      name,
      close: async () => {
        const emptied = this.#local.remove(name);
        await Promise.all([
          this.#shardFor(name).unsubscribe(name),
          ...emptied.map((group) => this.#shardFor(group).unsubscribe(group)),
        ]);
      },
    };
  }

  async send(channel: string, message: ChannelMessage): Promise<void> {
    assertChannelName(channel);
    await this.#shardFor(channel).publish(channel, await this.serialize(message));
  }

  async groupAdd(group: string, channel: string): Promise<void> {
    assertGroupName(group);
    this.#local.requireLocal(channel);
    const name = this.#groupChannel(group);
    this.#local.join(name, channel);
    try {
      // Even when already subscribed: it resolves only once the subscription is live.
      await this.#shardFor(name).subscribe(name);
    } catch (error) {
      this.#local.leave(name, channel);
      throw error;
    }
  }

  async groupDiscard(group: string, channel: string): Promise<void> {
    assertGroupName(group);
    const name = this.#groupChannel(group);
    if (this.#local.leave(name, channel)) await this.#shardFor(name).unsubscribe(name);
  }

  async groupSend(group: string, message: ChannelMessage): Promise<void> {
    assertGroupName(group);
    const name = this.#groupChannel(group);
    await this.#shardFor(name).publish(name, await this.serialize(message));
  }

  async flush(): Promise<void> {
    this.#local.clear();
    await Promise.all(this.#shards.map((shard) => shard.close()));
  }

  #receive(data: Buffer, name: Buffer): void {
    // Copied: decoded bytes would otherwise be Buffer views pinning the client's memory.
    const bytes = new Uint8Array(data);
    const channel = name.toString();
    this.#inbox = this.#inbox.then(async () => {
      try {
        const message = await this.deserialize(bytes);
        if (this.#local.handlers.has(channel)) this.#local.deliver(channel, message);
        else this.#local.deliverToGroup(channel, message);
      } catch (error) {
        this.#local.report(error);
      }
    });
  }

  #shardFor(name: string): Shard {
    return this.#shards[consistentHash(name, this.#shards.length)]!;
  }

  #groupChannel(group: string): string {
    return `${this.prefix}__group__${group}`;
  }
}

// The slice of node-redis a shard uses, which a plain client and a Sentinel one share.
interface Client {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
  publish(channel: string, message: Buffer): Promise<unknown>;
  subscribe(channel: string, listener: Listener, bufferMode: true): Promise<unknown>;
  unsubscribe(channel: string, listener: Listener, bufferMode: true): Promise<unknown>;
  close(): Promise<void>;
  destroy(): unknown;
  duplicate(): Client;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

type Listener = (message: Buffer, channel: Buffer) => void;

function clientFor(host: RedisHost): Client {
  if (typeof host === 'string') return createClient({ url: host });
  if ('sentinels' in host) {
    const { sentinels, masterName, ...options } = host;
    // Its unsubscribe types the listener for either buffer mode; the shard only uses buffers.
    return createSentinel({
      ...options,
      name: masterName,
      sentinelRootNodes: sentinels,
    }) as unknown as Client;
  }
  return createClient(host);
}

/**
 * One Redis server: a publishing connection and a subscribing one, opened on first use.
 * Subscription changes run one at a time, as under Python's per-shard lock, so a
 * subscribe resolves only once Redis has confirmed it.
 */
class Shard {
  private clients?: Promise<{ publisher: Client; subscriber: Client }>;
  private readonly subscribed = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: RedisHost,
    private readonly listener: Listener,
    private readonly onError: (error: unknown) => void,
  ) {}

  async publish(channel: string, data: Uint8Array): Promise<void> {
    const { publisher } = await this.connect();
    await publisher.publish(channel, Buffer.from(data));
  }

  subscribe(channel: string): Promise<void> {
    return this.serially(async () => {
      if (this.subscribed.has(channel)) return;
      const { subscriber } = await this.connect();
      await subscriber.subscribe(channel, this.listener, true);
      this.subscribed.add(channel);
    });
  }

  unsubscribe(channel: string): Promise<void> {
    return this.serially(async () => {
      if (!this.subscribed.delete(channel)) return;
      const { subscriber } = await this.connect();
      await subscriber.unsubscribe(channel, this.listener, true);
    });
  }

  close(): Promise<void> {
    return this.serially(async () => {
      const clients = await this.clients?.catch(() => undefined);
      this.clients = undefined;
      this.subscribed.clear();
      if (clients)
        await Promise.all([clients.publisher.close(), clients.subscriber.close()]);
    });
  }

  private serially<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private connect() {
    if (this.clients) return this.clients;
    const publisher = clientFor(this.host);
    const subscriber = publisher.duplicate();
    // Without a listener, node-redis turns a dropped connection into a crash.
    publisher.on('error', this.onError);
    subscriber.on('error', this.onError);

    const clients = Promise.all([publisher.connect(), subscriber.connect()]).then(
      () => ({ publisher, subscriber }),
      (error: unknown) => {
        // Retried on next use rather than cached, with nothing left open.
        if (this.clients === clients) this.clients = undefined;
        for (const client of [publisher, subscriber]) if (client.isOpen) client.destroy();
        throw error;
      },
    );
    this.clients = clients;
    return clients;
  }
}
