import { Injectable } from '@nestjs/common';
import type {
  AsyncAPIDocument,
  AsyncAPIOptions,
  Chanx,
  Message,
  PublishOptions,
} from '@chanx-js/server';
import type { Type } from '@nestjs/common';

/** Send events and publish to topics from anywhere in the app, typed by message. */
@Injectable()
export class ChanxService {
  private app?: Chanx;
  private readonly sources = new Map<Type, object>();

  /** Called by the explorer once the gateways are built. */
  attach(app: Chanx, sources: Map<Type, object>): void {
    this.app = app;
    for (const [gateway, source] of sources) this.sources.set(gateway, source);
  }

  /** Send an event to a consumer's groups, across processes. */
  broadcastEvent(
    consumer: Type,
    event: Message,
    groups?: readonly string[],
  ): Promise<void> {
    return this.chanx.broadcastEvent(
      this.source(consumer) as never,
      event as never,
      groups,
    );
  }

  /** Send an event to one connection, by its `channelName`. */
  sendEvent(consumer: Type, event: Message, channelName: string): Promise<void> {
    return this.chanx.sendEvent(
      this.source(consumer) as never,
      event as never,
      channelName,
    );
  }

  /** Publish an event to everyone subscribed to a topic, across processes. */
  publish(
    topic: Type,
    value: string,
    event: Message,
    options?: PublishOptions,
  ): Promise<void> {
    return this.chanx.publish(
      this.source(topic) as never,
      value,
      event as never,
      options,
    );
  }

  asyncapi(options?: AsyncAPIOptions): AsyncAPIDocument {
    return this.chanx.asyncapi(options);
  }

  private get chanx(): Chanx {
    if (!this.app)
      throw new Error('chanx is not ready until the application has bootstrapped');
    return this.app;
  }

  private source(gateway: Type): object {
    const source = this.sources.get(gateway);
    if (!source)
      throw new Error(`${gateway.name} is not a @ChanxConsumer or @ChanxTopic provider`);
    return source;
  }
}
