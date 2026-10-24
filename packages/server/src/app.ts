import type { ChannelLayer } from '@chanx-js/layers';
import { InMemoryChannelLayer } from '@chanx-js/layers';

import type { AsyncAPIDocument, AsyncAPIOptions } from './asyncapi';
import { generateAsyncAPI } from './asyncapi';
import type { AsyncJsonWebsocketConsumer } from './classes';
import type { ConsumerDefinition, ConsumerSource, EventsOf } from './consumer';
import { definitionOf } from './consumer';
import type { PublishOptions, TopicLike } from './topic';
import { topicDefinitionOf } from './topic';
import type { Session } from './session';
import { CHANNEL_EVENT, TOPIC_EVENT, openSession, topicGroup } from './session';

/** Where chanx reports handler failures and development warnings. */
export interface Logger {
  error(...data: unknown[]): void;
  warn(...data: unknown[]): void;
}

/** How a server adapter hands chanx an accepted socket. */
export interface Transport {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Options for `createChanx()`. */
export interface ChanxOptions {
  /** The consumers to serve: `consumer()` builders or `@Consumer` classes. */
  consumers: readonly ConsumerLike[];
  /** Channel layers by name. Defaults to `{ default: new InMemoryChannelLayer() }`. */
  layers?: Readonly<Record<string, ChannelLayer>>;
  /** Convert keys between snake_case on the server and camelCase on the wire. Defaults to `false`. */
  camelize?: boolean;
  /** Send a `complete` frame after each handled frame. Defaults to `false`. */
  sendCompletion?: boolean;
  /** Defaults to `console`. */
  logger?: Logger;
  /** Development checks, such as undeclared replies. Defaults to `NODE_ENV !== 'production'`. */
  dev?: boolean;
}

/** A `consumer()` builder, or a class decorated with `@Consumer`. */
export type ConsumerLike =
  ConsumerSource | (abstract new (conn: never) => AsyncJsonWebsocketConsumer<unknown>);

export interface ResolvedOptions {
  camelize: boolean;
  sendCompletion: boolean;
  logger: Logger;
  dev: boolean;
}

/** A chanx app: serves consumers through an adapter, and sends to them from anywhere. */
export interface Chanx {
  /** Whether a path belongs to a consumer, so an adapter can leave other upgrades alone. */
  match(path: string): boolean;
  /** Serve an accepted socket. Returns `undefined` when no consumer serves the URL. */
  connect(
    request: { url: string | URL; headers?: HeadersInit },
    transport: Transport,
  ): Session | undefined;
  /**
   * Send an event to a consumer's groups, from anywhere: a request handler, a worker,
   * another process. Groups default to the consumer's own.
   */
  broadcastEvent<C extends ConsumerLike>(
    consumer: C,
    event: EventsOf<C>,
    groups?: readonly string[],
  ): Promise<void>;
  /**
   * Publish an event to everyone subscribed to a topic, from anywhere. `seq` is
   * caller-assigned, for gap detection only.
   */
  publish<T extends TopicLike>(
    topic: T,
    value: string,
    event: EventsOf<T>,
    options?: PublishOptions,
  ): Promise<void>;
  /** The AsyncAPI 3 document for these consumers, for docs and `@chanx-js/codegen`. */
  asyncapi(options?: AsyncAPIOptions): AsyncAPIDocument;
  /** Send an event to one connection, by its `channelName`. */
  sendEvent<C extends ConsumerLike>(
    consumer: C,
    event: EventsOf<C>,
    channelName: string,
  ): Promise<void>;
}

/** What `@chanx-js/server/testing`, the AsyncAPI handler and the adapters reach into. */
export const internals = new WeakMap<
  Chanx,
  {
    layerOf(source: { options: { layer?: string } }): ChannelLayer;
    logger: Logger;
    /** Every consumer's path pattern, such as `/ws/chat/{room}`. */
    paths: readonly string[];
  }
>();

interface Route {
  definition: ConsumerDefinition;
  match(path: string): Record<string, string> | null;
}

export function createChanx(options: ChanxOptions): Chanx {
  const resolved: ResolvedOptions = {
    camelize: options.camelize ?? false,
    sendCompletion: options.sendCompletion ?? false,
    logger: options.logger ?? console,
    dev: options.dev ?? globalThis.process?.env?.NODE_ENV !== 'production',
  };
  const layers = options.layers ?? { default: new InMemoryChannelLayer() };
  const layerOf = ({ options }: { options: { layer?: string } }) => {
    const name = options.layer ?? 'default';
    const layer = layers[name];
    if (!layer)
      throw new Error(`No channel layer named "${name}" in createChanx({ layers })`);
    return layer;
  };
  const routes: Route[] = options.consumers.map((builder) => {
    const definition = definitionOf(builder);
    return { definition, match: compilePath(definition.path) };
  });
  const find = (path: string) => {
    for (const route of routes) {
      const params = route.match(path);
      if (params) return { route, params };
    }
    return undefined;
  };

  const app: Chanx = {
    match: (path) => find(path) !== undefined,
    connect(request, transport) {
      const url = new URL(request.url, 'ws://localhost');
      const found = find(url.pathname);
      if (!found) return undefined;
      return openSession(
        found.route.definition,
        { url, headers: new Headers(request.headers), params: found.params },
        transport,
        { ...resolved, layer: layerOf(found.route.definition) },
      );
    },
    async broadcastEvent(consumer, event, groups) {
      const definition = definitionOf(consumer);
      const targets = groups ?? definition.options.groups;
      if (!Array.isArray(targets)) {
        throw new Error(
          `broadcastEvent() needs groups: consumer "${definition.options.name}" has no fixed ones`,
        );
      }
      const layer = layerOf(definition);
      await Promise.all(
        (targets as readonly string[]).map((group) =>
          layer.groupSend(group, { type: CHANNEL_EVENT, event_data: event }),
        ),
      );
    },
    async publish(source, value, event, { seq } = {}) {
      const topic = topicDefinitionOf(source);
      if (!topic.match(value)) {
        throw new Error(`"${value}" is not a topic of pattern "${topic.pattern}"`);
      }
      await layerOf(topic).groupSend(topicGroup(topic, value), {
        type: TOPIC_EVENT,
        topic: value,
        seq: seq ?? null,
        event_data: event,
      });
    },
    asyncapi: (asyncapiOptions) =>
      generateAsyncAPI(
        routes.map((route) => route.definition),
        asyncapiOptions,
        { camelize: resolved.camelize },
      ),
    async sendEvent(consumer, event, channelName) {
      await layerOf(definitionOf(consumer)).send(channelName, {
        type: CHANNEL_EVENT,
        event_data: event,
      });
    },
  };
  internals.set(app, {
    layerOf,
    logger: resolved.logger,
    paths: routes.map((route) => route.definition.path),
  });
  return app;
}

// Path params match one segment, unlike topic params, which stop at ':'.
function compilePath(pattern: string): Route['match'] {
  const names: string[] = [];
  const source = pattern
    .split(/\{(\w+)\}/)
    .map((part, index) => {
      if (index % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(part);
      return '([^/]+)';
    })
    .join('');
  const regex = new RegExp(`^${source}$`);
  return (path) => {
    const match = regex.exec(path);
    if (!match) return null;
    return Object.fromEntries(
      names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]),
    );
  };
}
