import { formatPattern, parsePattern } from '@chanx-js/protocol';

import type {
  ConsumerBuilder,
  ConsumerOptions,
  HandlerDefinition,
  HandlerOptions,
  PathParams,
  HandlerSet,
  TopicSource,
  Connection,
} from './consumer';
import { TOPIC, build, handlerSetOf } from './consumer';
import type { AnyMessageDefinition, Message, MessageOf } from './messages';

export interface TopicContext<Pattern extends string, User, Emits extends Message> {
  readonly conn: Connection<string, User>;
  /** Params parsed from the topic: `room:{room_name}` subscribed as `room:lobby` gives `lobby`. */
  readonly params: PathParams<Pattern>;
  /** The topic string, such as `room:lobby`. */
  readonly topic: string;
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

export interface PublishOptions {
  /** Caller-assigned, for gap detection only; leave unset with several writers. */
  seq?: number;
}

export interface TopicOptions<Pattern extends string, User> {
  /**
   * Name of the topic's channel layer group namespace, as the Python class name: two
   * servers sharing a layer must agree on it. Defaults to `RoomTopic` for `room:{...}`.
   */
  name?: string;
  description?: string;
  /** The channel layer to publish on. Defaults to `default`. */
  layer?: string;
  /** Decide whether this connection may subscribe. */
  authorize?: (subscription: {
    params: PathParams<Pattern>;
    conn: Connection<string, User>;
    topic: string;
  }) => boolean | Promise<boolean>;
  /** Once subscribed; what it sends is state, not a reply, so it carries no `ref`. */
  onSubscribe?: (ctx: TopicContext<Pattern, User, Message>) => void | Promise<void>;
  /** Before leaving, on unsubscribe and on disconnect. */
  onUnsubscribe?: (ctx: TopicContext<Pattern, User, Message>) => void | Promise<void>;
}

/** Runtime form of a topic: what dispatch and AsyncAPI read. */
export interface TopicDefinition {
  readonly pattern: string;
  readonly name: string;
  readonly match: (topic: string) => Record<string, string> | null;
  readonly options: TopicOptions<string, unknown>;
  readonly handlers: ReadonlyMap<string, HandlerDefinition>;
  readonly events: ReadonlyMap<string, HandlerDefinition>;
  readonly passthrough: readonly AnyMessageDefinition[];
}

type Outputs = AnyMessageDefinition | readonly AnyMessageDefinition[];
type OutputMessages<O> = [O] extends [never]
  ? never
  : MessageOf<O extends readonly (infer D)[] ? D : O>;
type Returned<O> = [O] extends [never] ? void : OutputMessages<O>;
type Handler<In, Ctx, Out> = (message: In, ctx: Ctx) => Out | Promise<Out>;

export interface TopicBuilder<
  Pattern extends string,
  User,
  Emits extends Message = never,
  Events extends Message = never,
> extends TopicSource {
  readonly '~events'?: Events;
  on<D extends AnyMessageDefinition>(
    message: D,
    handler: Handler<MessageOf<D>, TopicContext<Pattern, User, Emits>, void | Emits>,
  ): TopicBuilder<Pattern, User, Emits, Events>;
  on<D extends AnyMessageDefinition, const O extends Outputs = never>(
    message: D,
    options: HandlerOptions<O>,
    handler: Handler<
      MessageOf<D>,
      TopicContext<Pattern, User, Emits | OutputMessages<O>>,
      Returned<O>
    >,
  ): TopicBuilder<Pattern, User, Emits, Events>;
  event<D extends AnyMessageDefinition>(
    message: D,
    handler: Handler<MessageOf<D>, TopicContext<Pattern, User, Emits>, void | Emits>,
  ): TopicBuilder<Pattern, User, Emits, Events | MessageOf<D>>;
  event<D extends AnyMessageDefinition, const O extends Outputs = never>(
    message: D,
    options: HandlerOptions<O>,
    handler: Handler<
      MessageOf<D>,
      TopicContext<Pattern, User, Emits | OutputMessages<O>>,
      Returned<O>
    >,
  ): TopicBuilder<Pattern, User, Emits, Events | MessageOf<D>>;
  passthrough<const D extends readonly AnyMessageDefinition[]>(
    ...messages: D
  ): TopicBuilder<Pattern, User, Emits, Events | MessageOf<D[number]>>;
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
export function topic<const Pattern extends string, User = unknown>(
  pattern: Pattern,
  options: TopicOptions<Pattern, User> = {},
): TopicBuilder<Pattern, User> {
  return topicFrom({
    pattern,
    name: options.name ?? defaultName(pattern),
    match: parsePattern(pattern),
    options: options as TopicOptions<string, unknown>,
    handlers: new Map(),
    events: new Map(),
    passthrough: [],
  }) as never;
}

function topicFrom(definition: TopicDefinition): object {
  // Handler bookkeeping and its rules are the consumer builder's.
  const set = build({
    handlers: definition.handlers,
    events: definition.events,
    passthrough: definition.passthrough,
    owner: `Topic "${definition.pattern}"`,
  });
  const next = (built: HandlerSet) =>
    topicFrom({ ...definition, ...handlerSetOf(built) });
  return {
    [TOPIC]: definition,
    on: (...args: Parameters<typeof set.on>) => next(set.on(...args)),
    event: (...args: Parameters<typeof set.event>) => next(set.event(...args)),
    passthrough: (...messages: AnyMessageDefinition[]) =>
      next(set.passthrough(...messages)),
    with: (params: Record<string, string | number>) =>
      formatPattern(definition.pattern, params),
    asConsumer: (path: string, { name, ...options }: { name?: string } = {}) =>
      build({
        path,
        options: { ...options, name: name ?? snakeCase(definition.name) },
        handlers: new Map(),
        events: new Map(),
        passthrough: [],
        topics: [definition],
        defaultTopic: definition,
      }),
  };
}

function defaultName(pattern: string): string {
  const prefix = pattern.split(/[:{]/)[0] ?? '';
  const words = prefix.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return `${words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join('')}Topic`;
}

function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
