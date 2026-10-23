import { formatPattern, parsePattern } from '@chanx-js/protocol';

import type { Subscription } from './classes';
import { Topic, handlersFromClass } from './classes';
import type {
  Connection,
  ConsumerBuilder,
  ConsumerDefinition,
  ConsumerOptions,
  HandlerDefinition,
  HandlerOptions,
  HandlerSet,
  PathParams,
  TopicSource,
} from './consumer';
import { TOPIC, build, handlerSetOf } from './consumer';
import type { AnyMessageDefinition, Message, MessageOf } from './messages';

export interface TopicContext<
  Pattern extends string,
  User,
  Emits extends Message,
  State = unknown,
> {
  readonly conn: Connection<string, User>;
  /** Params parsed from the topic: `room:{room_name}` subscribed as `room:lobby` gives `lobby`. */
  readonly params: PathParams<Pattern>;
  /** The topic string, such as `room:lobby`. */
  readonly topic: string;
  /** This subscription's state, from the `state` option. */
  readonly state: State;
  /** The `ref` of the frame being handled; absent in lifecycle hooks and events. */
  readonly ref: string | undefined;
  readonly signal: AbortSignal;
  /** Send on this topic, stamped with the frame's `ref`. */
  send(message: Emits): Promise<void>;
  /** Send on this topic as a server push, without a `ref`. */
  push(message: Emits): Promise<void>;
  /** Publish an event to everyone subscribed to this topic, as Python's `Topic.broadcast`. */
  publish(event: Message, options?: PublishOptions): Promise<void>;
}

/** What a `Topic` class's handlers receive as their second argument. */
export type TopicClassContext = TopicContext<string, any, Message, Topic<any>>;

export interface PublishOptions {
  /** Caller-assigned, for gap detection only; leave unset with several writers. */
  seq?: number;
}

export interface TopicOptions<
  Pattern extends string,
  User,
  State = Record<never, never>,
> {
  /**
   * Name of the topic's channel layer group namespace, as the Python class name: two
   * servers sharing a layer must agree on it. Defaults to `RoomTopic` for `room:{...}`.
   */
  name?: string;
  description?: string;
  /** The channel layer to publish on. Defaults to `default`. */
  layer?: string;
  /** Per-subscription state, available as `ctx.state`; built before `authorize`. */
  state?: (subscription: Subscription<User>) => State;
  /** Decide whether this connection may subscribe. */
  authorize?: (subscription: {
    params: PathParams<Pattern>;
    conn: Connection<string, User>;
    topic: string;
    state: State;
  }) => boolean | Promise<boolean>;
  /** Once subscribed; what it sends is state, not a reply, so it carries no `ref`. */
  onSubscribe?: (
    ctx: TopicContext<Pattern, User, Message, State>,
  ) => void | Promise<void>;
  /** Before leaving, on unsubscribe and on disconnect. */
  onUnsubscribe?: (
    ctx: TopicContext<Pattern, User, Message, State>,
  ) => void | Promise<void>;
}

/** Runtime form of a topic: what dispatch and AsyncAPI read. */
export interface TopicDefinition {
  readonly pattern: string;
  readonly name: string;
  readonly match: (topic: string) => Record<string, string> | null;
  readonly options: TopicOptions<string, unknown, unknown>;
  readonly handlers: ReadonlyMap<string, HandlerDefinition>;
  readonly events: ReadonlyMap<string, HandlerDefinition>;
  readonly passthrough: readonly AnyMessageDefinition[];
}

/** A `topic()` builder, or a class extending `Topic`. */
export type TopicLike = TopicSource | (abstract new (subscription: never) => Topic<any>);

type Outputs = AnyMessageDefinition | readonly AnyMessageDefinition[];
type OutputMessages<O> = [O] extends [never]
  ? never
  : MessageOf<O extends readonly (infer D)[] ? D : O>;
type Returned<O> = [O] extends [never] ? void : OutputMessages<O>;
type Handler<In, Ctx, Out> = (message: In, ctx: Ctx) => Out | Promise<Out>;

export interface TopicBuilder<
  Pattern extends string,
  User,
  State = Record<never, never>,
  Emits extends Message = never,
  Events extends Message = never,
> extends TopicSource {
  readonly '~events'?: Events;
  on<D extends AnyMessageDefinition>(
    message: D,
    handler: Handler<
      MessageOf<D>,
      TopicContext<Pattern, User, Emits, State>,
      void | Emits
    >,
  ): TopicBuilder<Pattern, User, State, Emits, Events>;
  on<D extends AnyMessageDefinition, const O extends Outputs = never>(
    message: D,
    options: HandlerOptions<O>,
    handler: Handler<
      MessageOf<D>,
      TopicContext<Pattern, User, Emits | OutputMessages<O>, State>,
      Returned<O>
    >,
  ): TopicBuilder<Pattern, User, State, Emits, Events>;
  event<D extends AnyMessageDefinition>(
    message: D,
    handler: Handler<
      MessageOf<D>,
      TopicContext<Pattern, User, Emits, State>,
      void | Emits
    >,
  ): TopicBuilder<Pattern, User, State, Emits, Events | MessageOf<D>>;
  event<D extends AnyMessageDefinition, const O extends Outputs = never>(
    message: D,
    options: HandlerOptions<O>,
    handler: Handler<
      MessageOf<D>,
      TopicContext<Pattern, User, Emits | OutputMessages<O>, State>,
      Returned<O>
    >,
  ): TopicBuilder<Pattern, User, State, Emits, Events | MessageOf<D>>;
  passthrough<const D extends readonly AnyMessageDefinition[]>(
    ...messages: D
  ): TopicBuilder<Pattern, User, State, Emits, Events | MessageOf<D[number]>>;
  /** The topic string for these params: `roomTopic.with({ room_name: 'lobby' })`. */
  with(params: PathParams<Pattern>): string;
  /**
   * Serve this topic alone on a route, where connecting subscribes it from the URL params
   * and frames need no envelope, as Python's `Topic.as_consumer()`.
   */
  asConsumer<const Path extends string>(
    path: Path,
    options?: Omit<
      ConsumerOptions<Path, Record<never, never>, User, never>,
      'topics' | 'name'
    > & {
      name?: string;
    },
  ): ConsumerBuilder<Path, Record<never, never>, User, never, Events>;
}

/** A subscribable stream on a connection, addressed as its pattern filled in. */
export function topic<
  const Pattern extends string,
  User = unknown,
  State = Record<never, never>,
>(
  pattern: Pattern,
  options: TopicOptions<Pattern, User, State> = {},
): TopicBuilder<Pattern, User, State> {
  return topicFrom({
    pattern,
    name: options.name ?? defaultName(pattern),
    match: parsePattern(pattern),
    options: options as TopicOptions<string, unknown, unknown>,
    handlers: new Map(),
    events: new Map(),
    passthrough: [],
  }) as never;
}

function topicFrom(definition: TopicDefinition): TopicSource {
  // Handler bookkeeping and its rules are the consumer builder's.
  const set = build({
    handlers: definition.handlers,
    events: definition.events,
    passthrough: definition.passthrough,
    owner: `Topic "${definition.pattern}"`,
  });
  const next = (built: HandlerSet) =>
    topicFrom({ ...definition, ...handlerSetOf(built) });
  const source = {
    [TOPIC]: definition,
    on: (...args: Parameters<typeof set.on>) => next(set.on(...args)),
    event: (...args: Parameters<typeof set.event>) => next(set.event(...args)),
    passthrough: (...messages: AnyMessageDefinition[]) =>
      next(set.passthrough(...messages)),
    with: (params: Record<string, string | number>) =>
      formatPattern(definition.pattern, params),
    asConsumer: (path: string, options: { name?: string } = {}) =>
      asConsumer(source, definition, path, options),
  };
  return source;
}

function asConsumer(
  source: TopicLike,
  definition: TopicDefinition,
  path: string,
  { name, ...options }: { name?: string },
) {
  return build({
    path,
    options: { ...options, name: name ?? snakeCase(definition.name) },
    handlers: new Map(),
    events: new Map(),
    passthrough: [],
    topics: [source],
    defaultTopic: source,
  });
}

const fromClasses = new WeakMap<object, TopicDefinition>();

export function topicDefinitionOf(source: TopicLike): TopicDefinition {
  if (TOPIC in source) return source[TOPIC];
  let definition = fromClasses.get(source);
  if (!definition) {
    definition = topicFromClass(
      source as typeof Topic & (new (subscription: never) => Topic),
    );
    fromClasses.set(source, definition);
  }
  return definition;
}

/** The topics a consumer mounts, resolved from builders and classes alike. */
export function topicsOf(definition: ConsumerDefinition): readonly TopicDefinition[] {
  return definition.topics.map(topicDefinitionOf);
}

function topicFromClass(
  target: typeof Topic & (new (subscription: never) => Topic),
): TopicDefinition {
  if (!(target.prototype instanceof Topic) || typeof target.pattern !== 'string') {
    throw new TypeError(
      `${target.name} is not a topic: extend Topic and set \`static pattern\`, or use topic()`,
    );
  }
  return {
    pattern: target.pattern,
    name: target.name,
    match: parsePattern(target.pattern),
    options: {
      description: target.description,
      layer: target.layer,
      state: (subscription) =>
        new (target as unknown as new (subscription: Subscription) => Topic)(
          subscription,
        ),
      authorize: ({ state }) => (state as Topic).authorize(),
      onSubscribe: (ctx) => (ctx.state as Topic).onSubscribe(),
      onUnsubscribe: (ctx) => (ctx.state as Topic).onUnsubscribe(),
    },
    ...handlersFromClass(target),
    passthrough: target.passthrough ?? [],
  };
}

/** Serve a `Topic` class alone on a route, as `topic().asConsumer()` does for a builder. */
export function topicConsumer<const Path extends string>(
  target: TopicLike,
  path: Path,
  options: { name?: string } = {},
): ConsumerBuilder<Path, Record<never, never>, unknown, never> {
  return asConsumer(target, topicDefinitionOf(target), path, options) as never;
}

function defaultName(pattern: string): string {
  const prefix = pattern.split(/[:{]/)[0] ?? '';
  const words = prefix.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return `${words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join('')}Topic`;
}

function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
