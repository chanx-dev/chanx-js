import type { AnyMessageDefinition, Message, MessageOf } from './messages';
import { decamelizeKey } from './case';
import type { TopicDefinition } from './topic';

type ExtractParams<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | ExtractParams<Rest>
  : never;

/** The params a route pattern carries: `'/ws/chat/{room}'` gives `{ room: string }`. */
export type PathParams<Path extends string> = {
  readonly [K in ExtractParams<Path>]: string;
};

/** What a consumer sees of the HTTP upgrade request. */
export interface ConnectRequest<Path extends string = string> {
  readonly url: URL;
  readonly headers: Headers;
  readonly params: PathParams<Path>;
}

export interface Connection<
  Path extends string = string,
  User = unknown,
> extends ConnectRequest<Path> {
  readonly id: string;
  /** What `authenticate` returned; `undefined` on a consumer without one. */
  readonly user: User;
  /** This connection's channel on the layer, as Python's `channel_name`: what `sendEvent()` targets. */
  readonly channelName: string;
  /** Groups joined, from the `groups` option and `join()`. */
  readonly groups: readonly string[];
  join(group: string): Promise<void>;
  leave(group: string): Promise<void>;
  /** Send to this client as a server push, without a `ref`. */
  push(message: Message): Promise<void>;
  /** Send to every connection in the groups, as `ctx.broadcast()` does. */
  broadcast(message: Message, options?: BroadcastOptions): Promise<void>;
  close(code?: number, reason?: string): void;
}

export interface BroadcastOptions {
  /** Defaults to every group this connection joined. */
  groups?: readonly string[];
  /** Skip this connection, as Python's `exclude_current`. */
  excludeCurrent?: boolean;
}

export interface Context<Path extends string, State, User, Emits extends Message> {
  readonly conn: Connection<Path, User>;
  readonly params: PathParams<Path>;
  readonly state: State;
  /** The `ref` of the frame being handled, echoed on every reply. */
  readonly ref: string | undefined;
  /** Aborts when the connection closes, so long-running work can stop. */
  readonly signal: AbortSignal;
  /** Send on this connection, stamped with the frame's `ref`. */
  send(message: Emits): Promise<void>;
  /** Send on this connection as a server push, without a `ref`. */
  push(message: Emits): Promise<void>;
  /** Send to every connection in the groups, across processes, as Python's `broadcast_message`. */
  broadcast(message: Emits, options?: BroadcastOptions): Promise<void>;
}

export interface HandlerOptions<Out> {
  /** What the handler returns: one message or a list. Documented, and checked in development. */
  output?: Out;
  summary?: string;
  description?: string;
  tags?: string[];
}

type OutputsOf<O> = O extends readonly (infer D)[] ? D : O;
type OutputMessages<O> = [O] extends [never] ? never : MessageOf<OutputsOf<O>>;
type Returned<O> = [O] extends [never] ? void : OutputMessages<O>;
type Handler<In, Ctx, Out> = (message: In, ctx: Ctx) => Out | Promise<Out>;
type Outputs = AnyMessageDefinition | readonly AnyMessageDefinition[];

/** Runtime form of one handler, whichever surface defined it. */
export interface HandlerDefinition {
  /** The AsyncAPI operation name, as a Python handler's method name. */
  readonly name?: string;
  readonly message: AnyMessageDefinition;
  readonly outputs: readonly AnyMessageDefinition[];
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly handle: (message: Message, ctx: Context<string, any, any, any>) => unknown;
}

interface HandlerSetDefinition {
  readonly handlers: ReadonlyMap<string, HandlerDefinition>;
  readonly events: ReadonlyMap<string, HandlerDefinition>;
  readonly passthrough: readonly AnyMessageDefinition[];
}

export interface ConsumerOptions<
  Path extends string,
  State,
  User,
  Emits extends AnyMessageDefinition,
> {
  /** The AsyncAPI channel name, as Python's `@channel(name=...)`. */
  name: string;
  description?: string;
  tags?: string[];
  /** Messages pushed through `ctx` rather than returned by a handler. */
  emits?: readonly Emits[];
  /** Topics clients can subscribe to on this connection. */
  topics?: readonly TopicSource[];
  /** The channel layer to use, by its name in `createChanx({ layers })`. Defaults to `default`. */
  layer?: string;
  /** Groups to join once connected. */
  groups?: readonly string[] | ((conn: Connection<Path, User>) => readonly string[]);
  /** Per-connection state, available as `ctx.state`. */
  state?: (conn: Connection<Path, User>) => State;
  /**
   * Runs after the socket is accepted. Return the user, or `false` (or throw an
   * `AuthenticationError`) to reject; the client gets an `authentication` message either way.
   */
  authenticate?: (
    request: ConnectRequest<Path>,
  ) => User | false | null | undefined | Promise<User | false | null | undefined>;
  /** After authentication, as Python's `post_authentication`. */
  onConnect?: (ctx: Context<Path, State, User, MessageOf<Emits>>) => void | Promise<void>;
  onDisconnect?: (
    ctx: Context<Path, State, User, MessageOf<Emits>>,
  ) => void | Promise<void>;
}

/** Runtime form of a consumer: what dispatch and AsyncAPI read. */
export interface ConsumerDefinition extends HandlerSetDefinition {
  readonly path: string;
  readonly options: ConsumerOptions<string, unknown, unknown, AnyMessageDefinition>;
  readonly topics: readonly TopicDefinition[];
  /** Subscribed on connect and implied by frames without a topic, as `Topic.as_consumer()`. */
  readonly defaultTopic?: TopicDefinition;
}

const DEFINITION = Symbol('chanx.definition');
export const TOPIC = Symbol('chanx.topic');

/** Anything carrying a topic definition: a `topic()` builder. */
export interface TopicSource {
  readonly [TOPIC]: TopicDefinition;
}

/** Event handlers including passthrough events; an explicit handler wins, as in chanx. */
export function eventHandlersOf(
  definition: HandlerSetDefinition,
): Map<string, HandlerDefinition> {
  const handlers = new Map(definition.events);
  for (const message of definition.passthrough) {
    if (handlers.has(message.action)) continue;
    handlers.set(message.action, {
      message,
      outputs: [message],
      name: `handle_passthrough_${decamelizeKey(message.title)}`,
      description: `Passthrough handler for ${message.title}`,
      handle: (event) => event,
    });
  }
  return handlers;
}

export interface HandlerSet<Needs = unknown, Events extends Message = Message> {
  readonly [DEFINITION]: HandlerSetDefinition;
  /** Phantom: the consumer state this set's handlers rely on. */
  readonly needs?: (state: Needs) => void;
  /** Phantom: the events these handlers accept, for typed `broadcastEvent()`. */
  readonly '~events'?: Events;
}

type NeedsOf<S> = S extends { readonly needs?: (state: infer N) => void } ? N : never;

/** The events a consumer or handler set accepts. */
export type EventsOf<C> = C extends { readonly '~events'?: infer E }
  ? unknown extends E
    ? Message
    : E
  : Message;

type Next<
  Kind,
  Path extends string,
  State,
  User,
  Emits extends Message,
  Events extends Message,
> = Kind extends 'consumer'
  ? ConsumerBuilder<Path, State, User, Emits, Events>
  : HandlerSetBuilder<State, Events>;

interface HandlerMethods<
  Kind,
  Path extends string,
  State,
  User,
  Emits extends Message,
  Events extends Message,
> {
  on<D extends AnyMessageDefinition>(
    message: D,
    handler: Handler<MessageOf<D>, Context<Path, State, User, Emits>, void | Emits>,
  ): Next<Kind, Path, State, User, Emits, Events>;
  on<D extends AnyMessageDefinition, const O extends Outputs = never>(
    message: D,
    options: HandlerOptions<O>,
    handler: Handler<
      MessageOf<D>,
      Context<Path, State, User, Emits | OutputMessages<O>>,
      Returned<O>
    >,
  ): Next<Kind, Path, State, User, Emits, Events>;
  /** A server-side event from the channel layer, as Python's `@event_handler`. */
  event<D extends AnyMessageDefinition>(
    message: D,
    handler: Handler<MessageOf<D>, Context<Path, State, User, Emits>, void | Emits>,
  ): Next<Kind, Path, State, User, Emits, Events | MessageOf<D>>;
  event<D extends AnyMessageDefinition, const O extends Outputs = never>(
    message: D,
    options: HandlerOptions<O>,
    handler: Handler<
      MessageOf<D>,
      Context<Path, State, User, Emits | OutputMessages<O>>,
      Returned<O>
    >,
  ): Next<Kind, Path, State, User, Emits, Events | MessageOf<D>>;
  /** Events forwarded to the client unchanged, as Python's `passthrough_events`. */
  passthrough<const D extends readonly AnyMessageDefinition[]>(
    ...messages: D
  ): Next<Kind, Path, State, User, Emits, Events | MessageOf<D[number]>>;
}

export interface ConsumerBuilder<
  Path extends string,
  State,
  User,
  Emits extends Message,
  Events extends Message = never,
> extends HandlerMethods<'consumer', Path, State, User, Emits, Events> {
  readonly [DEFINITION]: ConsumerDefinition;
  readonly '~events'?: Events;
  /** Mount a reusable handler set; its required state must be part of this consumer's. */
  use<S extends HandlerSet<any, any>>(
    set: S &
      ([State] extends [NeedsOf<S>]
        ? unknown
        : { error: "this consumer's state lacks what the set needs" }),
  ): ConsumerBuilder<Path, State, User, Emits, Events | EventsOf<S>>;
}

export interface HandlerSetBuilder<Needs, Events extends Message = never>
  extends
    HandlerSet<Needs, Events>,
    HandlerMethods<'set', string, Needs, unknown, Message, Events> {}

/** Declare a consumer: a route and the messages it handles. */
export function consumer<
  const Path extends string,
  State = Record<never, never>,
  User = undefined,
  Emits extends AnyMessageDefinition = never,
>(
  path: Path,
  options: ConsumerOptions<Path, State, User, Emits>,
): ConsumerBuilder<Path, State, User, MessageOf<Emits>> {
  return build({
    path,
    options: options as ConsumerDefinition['options'],
    handlers: new Map(),
    events: new Map(),
    passthrough: [],
    topics: (options.topics ?? []).map((source) => source[TOPIC]),
  }) as never;
}

/** Handlers to mount on several consumers with `.use()`, stating the state they need. */
export function handlers<Needs = Record<never, never>>(): HandlerSetBuilder<Needs> {
  return build({ handlers: new Map(), events: new Map(), passthrough: [] }) as never;
}

/** The handlers, events and passthrough events a builder has collected. */
export function handlerSetOf(source: HandlerSet<any, any>): HandlerSetDefinition {
  return source[DEFINITION];
}

/** Definitions of consumers declared as classes, filled in by `@Consumer`. */
export const classDefinitions = new WeakMap<object, ConsumerDefinition>();

export function definitionOf(source: object): ConsumerDefinition {
  const definition =
    classDefinitions.get(source) ?? (source as Partial<HandlerSet>)[DEFINITION];
  if (!definition) {
    throw new TypeError(
      'Not a consumer: pass a consumer() builder or a class decorated with @Consumer',
    );
  }
  return definition as ConsumerDefinition;
}

type Definition = HandlerSetDefinition &
  Partial<Omit<ConsumerDefinition, keyof HandlerSetDefinition>> & { owner?: string };

/** The builder behind `consumer()`, `handlers()` and `topic()`. */
export function build(definition: Definition) {
  const owner =
    definition.owner ??
    (definition.options?.name ? `Consumer "${definition.options.name}"` : 'Handler set');
  const add = (
    kind: 'handlers' | 'events',
    message: AnyMessageDefinition,
    optionsOrHandler: HandlerOptions<Outputs> | HandlerDefinition['handle'],
    maybeHandler?: HandlerDefinition['handle'],
  ) => {
    const [options, handle] =
      typeof optionsOrHandler === 'function'
        ? [{} as HandlerOptions<Outputs>, optionsOrHandler]
        : [optionsOrHandler, maybeHandler!];
    const outputs = options.output === undefined ? [] : [options.output].flat();
    return build({
      ...definition,
      [kind]: withUnique(definition[kind], owner, kind, {
        message,
        outputs,
        summary: options.summary,
        description: options.description,
        tags: options.tags,
        handle,
      }),
    });
  };

  return {
    [DEFINITION]: definition,
    on: (message: AnyMessageDefinition, optionsOrHandler: never, handler?: never) =>
      add('handlers', message, optionsOrHandler, handler),
    event: (message: AnyMessageDefinition, optionsOrHandler: never, handler?: never) =>
      add('events', message, optionsOrHandler, handler),
    passthrough: (...messages: AnyMessageDefinition[]) =>
      build({ ...definition, passthrough: [...definition.passthrough, ...messages] }),
    use: (set: HandlerSet) => {
      const added = set[DEFINITION];
      let merged: Definition = {
        ...definition,
        passthrough: [...definition.passthrough, ...added.passthrough],
      };
      for (const kind of ['handlers', 'events'] as const) {
        for (const handler of added[kind].values()) {
          merged = { ...merged, [kind]: withUnique(merged[kind], owner, kind, handler) };
        }
      }
      return build(merged);
    },
  };
}

function withUnique(
  existing: ReadonlyMap<string, HandlerDefinition>,
  owner: string,
  kind: 'handlers' | 'events',
  handler: HandlerDefinition,
): ReadonlyMap<string, HandlerDefinition> {
  const action = handler.message.action;
  if (existing.has(action)) {
    const what = kind === 'handlers' ? 'message' : 'event';
    throw new TypeError(
      `${owner} has two ${what} handlers for action "${action}". Actions must be unique within a consumer.`,
    );
  }
  return new Map(existing).set(action, handler);
}
