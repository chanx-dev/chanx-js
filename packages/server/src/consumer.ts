import type { AnyMessageDefinition, Message, MessageOf } from './messages';
import type { ValidationIssue } from './validation';
import { decamelizeKey } from './case';
import type { TopicDefinition, TopicLike } from './topic';

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

/** One client connection, as handlers and hooks see it. */
export interface Connection<
  Path extends string = string,
  User = unknown,
> extends ConnectRequest<Path> {
  /** Unique per connection. */
  readonly id: string;
  /** What `authenticate` returned; `undefined` on a consumer without one. */
  readonly user: User;
  /** This connection's channel on the layer: what `sendEvent()` targets. */
  readonly channelName: string;
  /** Groups joined, from the `groups` option and `join()`. */
  readonly groups: readonly string[];
  /** Join a group at any time, such as on a client's request; its broadcasts then reach this connection. */
  join(group: string): Promise<void>;
  /** Leave a group joined from the options or with `join()`. */
  leave(group: string): Promise<void>;
  /** Send to this client as a server push, without a `ref`. */
  push(message: Message): Promise<void>;
  /** Send to every connection in the groups, as `ctx.broadcast()` does. */
  broadcast(message: Message, options?: BroadcastOptions): Promise<void>;
  close(code?: number, reason?: string): void;
}

/** Where a broadcast goes, and whether it skips the sender. */
export interface BroadcastOptions {
  /** Defaults to every group this connection joined. */
  groups?: readonly string[];
  /** Skip this connection. Defaults to `false`. */
  excludeCurrent?: boolean;
}

/** What a consumer's handlers and hooks get as `ctx`. */
export interface Context<Path extends string, State, User, Emits extends Message> {
  readonly conn: Connection<Path, User>;
  /** Params parsed from the route: `/ws/chat/{room}` gives `room`. */
  readonly params: PathParams<Path>;
  /** Per-connection state, from the `state` option. */
  readonly state: State;
  /** The `ref` of the frame being handled, echoed on every reply. */
  readonly ref: string | undefined;
  /** Aborts when the connection closes, so long-running work can stop. */
  readonly signal: AbortSignal;
  /** Send on this connection, stamped with the frame's `ref`. */
  send(message: Emits): Promise<void>;
  /** Send on this connection as a server push, without a `ref`. */
  push(message: Emits): Promise<void>;
  /** Send to every connection in the groups, across processes. */
  broadcast(message: Emits, options?: BroadcastOptions): Promise<void>;
}

/** Options for `.on()`, `.event()`, `@On` and `@OnEvent`. */
export interface HandlerOptions<Out> {
  /** The AsyncAPI operation name. Defaults to `handle_<action>`. */
  name?: string;
  /** What the handler returns or broadcasts: one message or a list. Documented, and a returned one is checked in development. */
  output?: Out;
  /** The AsyncAPI operation's summary. */
  summary?: string;
  /** The AsyncAPI operation's description. */
  description?: string;
  /** Tags on the AsyncAPI operation. */
  tags?: string[];
}

type OutputsOf<O> = O extends readonly (infer D)[] ? D : O;
type OutputMessages<O> = [O] extends [never] ? never : MessageOf<OutputsOf<O>>;
type Returned<O> = [O] extends [never] ? void : void | OutputMessages<O>;
type Handler<In, Ctx, Out> = (message: In, ctx: Ctx) => Out | Promise<Out>;
type Outputs = AnyMessageDefinition | readonly AnyMessageDefinition[];

/** Runtime form of one handler, whichever surface defined it. */
export interface HandlerDefinition {
  /** The AsyncAPI operation name. */
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

/** Where a consumer's `authenticate` reads a credential from, for the AsyncAPI document. */
export interface Credential {
  name: string;
  location: 'query' | 'header' | 'cookie';
  description?: string;
}

/** Options for `consumer()`. */
export interface ConsumerOptions<
  Path extends string,
  State,
  User,
  Emits extends AnyMessageDefinition,
> extends ErrorHooks<Context<Path, State, User, MessageOf<Emits>>> {
  /** The AsyncAPI channel name, also naming the consumer in errors. */
  name: string;
  /** The AsyncAPI channel's description. */
  description?: string;
  /** Tags on the AsyncAPI channel. */
  tags?: string[];
  /** Messages sent outside any handler, such as a welcome from `onConnect`. */
  emits?: readonly Emits[];
  /** Topics clients can subscribe to on this connection: `topic()` builders or `Topic` classes. */
  topics?: readonly TopicLike[];
  /** The channel layer to use, by its name in `createChanx({ layers })`. Defaults to `default`. */
  layer?: string;
  /** Groups to join once connected. */
  groups?: readonly string[] | ((conn: Connection<Path, User>) => readonly string[]);
  /** Per-connection state, available as `ctx.state`. */
  state?: (conn: Connection<Path, User>) => State;
  /**
   * Runs after the socket is accepted. Return the user, or `false` (or throw an
   * `AuthenticationError`) to reject; the client gets an `authentication` message either way.
   * `request` is the connection it authenticates, the same object as `ctx.conn` later.
   */
  authenticate?: (
    request: ConnectRequest<Path>,
  ) => User | false | null | undefined | Promise<User | false | null | undefined>;
  /**
   * Run `authenticate` before accepting the socket, and refuse it with an HTTP status
   * instead of an `authentication` message: for server-to-server clients, or to hold no
   * socket for anonymous traffic. A browser cannot read why its upgrade failed.
   */
  rejectBeforeUpgrade?: boolean;
  /** Where `authenticate` reads credentials, documented as AsyncAPI security schemes. */
  credentials?: readonly Credential[];
  /** Runs once authenticated and the groups are joined. */
  onConnect?: (ctx: Context<Path, State, User, MessageOf<Emits>>) => void | Promise<void>;
  /** Runs when the socket closes, before the groups are left. */
  onDisconnect?: (
    ctx: Context<Path, State, User, MessageOf<Emits>>,
  ) => void | Promise<void>;
}

/** Overrides for how failures reach the client. Each defaults to what chanx does. */
export interface ErrorHooks<Ctx> {
  /** A frame failed validation. Default: an `error` frame listing the issues. */
  onValidationError?: (issues: ValidationIssue[], ctx: Ctx) => void | Promise<void>;
  /** A message handler threw. Default: log it, and an `error` frame naming the action. */
  onHandlerError?: (error: unknown, message: Message, ctx: Ctx) => void | Promise<void>;
  /** An event handler threw. Default: log it; the client is told nothing. */
  onEventError?: (error: unknown, event: Message, ctx: Ctx) => void | Promise<void>;
}

/** Runtime form of a consumer: what dispatch and AsyncAPI read. */
export interface ConsumerDefinition extends HandlerSetDefinition {
  readonly path: string;
  readonly options: ConsumerOptions<string, unknown, unknown, AnyMessageDefinition>;
  readonly topics: readonly TopicLike[];
  /** Subscribed on connect, and implied by frames without a topic. */
  readonly defaultTopic?: TopicLike;
}

const DEFINITION = Symbol('chanx.definition');
export const TOPIC = Symbol('chanx.topic');

/** Anything carrying a consumer definition: a `consumer()` builder. */
export interface ConsumerSource {
  readonly [DEFINITION]: ConsumerDefinition;
}

/** Anything carrying a topic definition: a `topic()` builder. */
export interface TopicSource {
  readonly [TOPIC]: TopicDefinition;
}

/** Event handlers including passthrough events; an explicit handler wins. */
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

/** Handlers from `handlers()`, to mount on consumers with `.use()`. */
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
  /** Handle a client message. */
  on<D extends AnyMessageDefinition>(
    message: D,
    handler: Handler<MessageOf<D>, Context<Path, State, User, Emits>, void | Emits>,
  ): Next<Kind, Path, State, User, Emits, Events>;
  /** Handle a client message; `output` declares what it returns or broadcasts. */
  on<D extends AnyMessageDefinition, const O extends Outputs = never>(
    message: D,
    options: HandlerOptions<O>,
    handler: Handler<
      MessageOf<D>,
      Context<Path, State, User, Emits | OutputMessages<O>>,
      Returned<O>
    >,
  ): Next<Kind, Path, State, User, Emits, Events>;
  /** Handle a server-side event from the channel layer. */
  event<D extends AnyMessageDefinition>(
    message: D,
    handler: Handler<MessageOf<D>, Context<Path, State, User, Emits>, void | Emits>,
  ): Next<Kind, Path, State, User, Emits, Events | MessageOf<D>>;
  /** Handle a server-side event; `output` declares what it returns or broadcasts to the client. */
  event<D extends AnyMessageDefinition, const O extends Outputs = never>(
    message: D,
    options: HandlerOptions<O>,
    handler: Handler<
      MessageOf<D>,
      Context<Path, State, User, Emits | OutputMessages<O>>,
      Returned<O>
    >,
  ): Next<Kind, Path, State, User, Emits, Events | MessageOf<D>>;
  /** Events forwarded to the client unchanged. */
  passthrough<const D extends readonly AnyMessageDefinition[]>(
    ...messages: D
  ): Next<Kind, Path, State, User, Emits, Events | MessageOf<D[number]>>;
}

/** What `consumer()` returns: chain handlers, then pass it to `createChanx()`. */
export interface ConsumerBuilder<
  Path extends string,
  State,
  User,
  Emits extends Message,
  Events extends Message = never,
>
  extends HandlerMethods<'consumer', Path, State, User, Emits, Events>, ConsumerSource {
  readonly '~events'?: Events;
  /** Mount a reusable handler set; its required state must be part of this consumer's. */
  use<S extends HandlerSet<never, Message>>(
    set: S &
      ([State] extends [NeedsOf<S>]
        ? unknown
        : { error: "this consumer's state lacks what the set needs" }),
  ): ConsumerBuilder<Path, State, User, Emits, Events | EventsOf<S>>;
}

/** What `handlers()` returns: chain handlers, then mount it with `.use()`. */
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
    topics: options.topics ?? [],
  }) as never;
}

/** Handlers to mount on several consumers with `.use()`, stating the state they need. */
export function handlers<Needs = Record<never, never>>(): HandlerSetBuilder<Needs> {
  return build({ handlers: new Map(), events: new Map(), passthrough: [] }) as never;
}

/** The handlers, events and passthrough events a builder has collected. */
export function handlerSetOf(source: HandlerSet<never, Message>): HandlerSetDefinition {
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
  Partial<Omit<ConsumerDefinition, keyof HandlerSetDefinition>>;
type Handle = HandlerDefinition['handle'];
/** A handler, or options then a handler: the two forms of `.on()` and `.event()`. */
export type HandlerArgs =
  [handle: Handle] | [options: HandlerOptions<Outputs>, handle: Handle];

/**
 * The builder behind `consumer()`, `handlers()` and `topic()`. `errorLabel` names the
 * builder in errors, defaulting to the consumer's name.
 */
export function build(
  definition: Definition,
  errorLabel = definition.options?.name
    ? `Consumer "${definition.options.name}"`
    : 'Handler set',
) {
  const next = (changed: Definition) => build(changed, errorLabel);
  const add = (
    kind: 'handlers' | 'events',
    message: AnyMessageDefinition,
    args: HandlerArgs,
  ) => {
    const [options, handle] = args.length === 1 ? [{}, args[0]] : args;
    const outputs = options.output === undefined ? [] : [options.output].flat();
    return next({
      ...definition,
      [kind]: withUnique(definition[kind], errorLabel, kind, {
        name: options.name,
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
    on: (message: AnyMessageDefinition, ...args: HandlerArgs) =>
      add('handlers', message, args),
    event: (message: AnyMessageDefinition, ...args: HandlerArgs) =>
      add('events', message, args),
    passthrough: (...messages: AnyMessageDefinition[]) =>
      next({ ...definition, passthrough: [...definition.passthrough, ...messages] }),
    use: (set: HandlerSet) => {
      const added = set[DEFINITION];
      let merged: Definition = {
        ...definition,
        passthrough: [...definition.passthrough, ...added.passthrough],
      };
      for (const kind of ['handlers', 'events'] as const) {
        for (const handler of added[kind].values()) {
          merged = {
            ...merged,
            [kind]: withUnique(merged[kind], errorLabel, kind, handler),
          };
        }
      }
      return next(merged);
    },
  };
}

function withUnique(
  existing: ReadonlyMap<string, HandlerDefinition>,
  errorLabel: string,
  kind: 'handlers' | 'events',
  handler: HandlerDefinition,
): ReadonlyMap<string, HandlerDefinition> {
  const action = handler.message.action;
  if (existing.has(action)) {
    const what = kind === 'handlers' ? 'message' : 'event';
    throw new TypeError(
      `${errorLabel} has two ${what} handlers for action "${action}". Actions must be unique within a consumer.`,
    );
  }
  return new Map(existing).set(action, handler);
}
