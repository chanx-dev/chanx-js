import type {
  BroadcastOptions,
  Connection,
  ConsumerDefinition,
  ConsumerOptions,
  Context,
  ErrorHooks,
  HandlerDefinition,
  HandlerOptions,
} from './consumer';
import { decamelizeKey } from './case';
import { classDefinitions } from './consumer';
import type { AnyMessageDefinition, Message, MessageOf } from './messages';
import type { PublishOptions, TopicClassContext } from './topic';
import type { ValidationIssue } from './validation';

/**
 * Base class for consumers written as classes. One instance serves one connection, so its
 * fields are per-connection state.
 */
export abstract class AsyncJsonWebsocketConsumer<User = unknown> {
  constructor(readonly conn: Connection<string, User>) {}

  /** Params parsed from the route. */
  get params(): Readonly<Record<string, string>> {
    return this.conn.params;
  }

  /** Send to this client as a server push, without a `ref`. */
  push(message: Message): Promise<void> {
    return this.conn.push(message);
  }

  /** Send to every connection in the groups, across processes. */
  broadcast(message: Message, options?: BroadcastOptions): Promise<void> {
    return this.conn.broadcast(message, options);
  }

  /** Runs once authenticated and the groups are joined. */
  onConnect(): void | Promise<void> {}

  /** Runs when the socket closes, before the groups are left. */
  onDisconnect(): void | Promise<void> {}

  /** Override to change how a frame that failed validation is answered. */
  onValidationError?(issues: ValidationIssue[], ctx: ClassContext): void | Promise<void>;
  /** Override to change how a failing message handler is reported. */
  onHandlerError?(
    error: unknown,
    message: Message,
    ctx: ClassContext,
  ): void | Promise<void>;
  /** Override to change how a failing event handler is reported. */
  onEventError?(error: unknown, event: Message, ctx: ClassContext): void | Promise<void>;
}

const HOOKS = ['onValidationError', 'onHandlerError', 'onEventError'] as const;

/** Error hooks a class overrides, called on the instance serving the connection or subscription. */
export function classErrorHooks(prototype: object): ErrorHooks<{ state: unknown }> {
  return Object.fromEntries(
    HOOKS.filter(
      (hook) => typeof (prototype as Record<string, unknown>)[hook] === 'function',
    ).map((hook) => [
      hook,
      (...args: unknown[]) => {
        const ctx = args.at(-1) as {
          state: Record<string, (...a: unknown[]) => unknown>;
        };
        return ctx.state[hook]!(...args);
      },
    ]),
  );
}

type ConsumerClass = abstract new (conn: never) => AsyncJsonWebsocketConsumer<unknown>;

/** What a class consumer's handlers receive as their second argument. */
export type ClassContext<User = unknown> = Context<
  string,
  AsyncJsonWebsocketConsumer<User>,
  User,
  Message
>;

type OutputMessages<O> = [O] extends [never]
  ? never
  : MessageOf<O extends readonly (infer D)[] ? D : O>;
type Returned<O> = [O] extends [never] ? void | Message : OutputMessages<O>;
type Outputs = AnyMessageDefinition | readonly AnyMessageDefinition[];

// `never` accepts any context annotation: a consumer's or a topic's.
type HandlerMethod<D, O> = (
  message: MessageOf<D>,
  ctx: never,
) => Returned<O> | Promise<Returned<O>>;

/** Works as a standard decorator and as a legacy one (`experimentalDecorators`, as Nest uses). */
interface MethodDecorator<Method> {
  (value: Method, context: ClassMethodDecoratorContext): void;
  <M extends Method>(
    target: object,
    key: string | symbol,
    descriptor: TypedPropertyDescriptor<M>,
  ): void;
}

interface ClassDecorator {
  <C extends ConsumerClass>(value: C, context: ClassDecoratorContext<C>): void;
  <C extends ConsumerClass>(target: C): void;
}

type Marked = {
  kind: 'handlers' | 'events';
  message: AnyMessageDefinition;
  options: HandlerOptions<Outputs>;
};

// Kept on the method itself, so it survives inheritance and both decorator systems.
const MARK = Symbol('chanx.handler');

function mark(
  kind: Marked['kind'],
  message: AnyMessageDefinition,
  options: HandlerOptions<Outputs>,
) {
  return (valueOrTarget: unknown, _context: unknown, descriptor?: PropertyDescriptor) => {
    const method = (descriptor ? descriptor.value : valueOrTarget) as Record<
      symbol,
      unknown
    >;
    if (method[MARK]) throw new TypeError('A method can handle only one message');
    method[MARK] = { kind, message, options } satisfies Marked;
  };
}

/** Handle a client message. Return a declared `output` to reply. */
export function On<D extends AnyMessageDefinition, const O extends Outputs = never>(
  message: D,
  options: HandlerOptions<O> = {},
): MethodDecorator<HandlerMethod<D, O>> {
  return mark('handlers', message, options) as never;
}

/** Handle a server-side event from the channel layer. */
export function OnEvent<D extends AnyMessageDefinition, const O extends Outputs = never>(
  message: D,
  options: HandlerOptions<O> = {},
): MethodDecorator<HandlerMethod<D, O>> {
  return mark('events', message, options) as never;
}

/** Options for `@Consumer`: `consumer()`'s, less what the class's methods provide. */
export type ClassConsumerOptions = Omit<
  ConsumerOptions<string, unknown, unknown, AnyMessageDefinition>,
  'state' | 'onConnect' | 'onDisconnect'
> & {
  /** Events forwarded to the client unchanged. */
  passthrough?: readonly AnyMessageDefinition[];
};

/** Declare a class as a consumer on a route; its `@On` and `@OnEvent` methods are its handlers. */
export function Consumer(path: string, options: ClassConsumerOptions): ClassDecorator {
  return ((target: ConsumerClass) => {
    classDefinitions.set(target, definitionFromClass(target, path, options));
  }) as never;
}

function definitionFromClass(
  target: ConsumerClass,
  path: string,
  { passthrough = [], topics = [], ...options }: ClassConsumerOptions,
): ConsumerDefinition {
  return {
    path,
    options: {
      ...options,
      state: (conn) =>
        new (target as unknown as new (conn: Connection) => AsyncJsonWebsocketConsumer)(
          conn,
        ),
      onConnect: (ctx) => (ctx.state as AsyncJsonWebsocketConsumer).onConnect(),
      onDisconnect: (ctx) => (ctx.state as AsyncJsonWebsocketConsumer).onDisconnect(),
      ...classErrorHooks(target.prototype),
    },
    ...handlersFromClass(target),
    passthrough,
    topics,
  };
}

/** One `@On` or `@OnEvent` method of a class. */
export interface HandlerMethodInfo {
  readonly name: string;
  readonly kind: 'handlers' | 'events';
  readonly message: AnyMessageDefinition;
  readonly options: HandlerOptions<
    AnyMessageDefinition | readonly AnyMessageDefinition[]
  >;
}

/**
 * A class's `@On` and `@OnEvent` methods, walking its prototype chain: an override, decorated or not, hides the method it overrides, and two methods
 * handling one action are an error. For framework integrations such as NestJS.
 */
export function handlerMethods(
  target: abstract new (...args: never[]) => unknown,
): HandlerMethodInfo[] {
  const methods: HandlerMethodInfo[] = [];
  const methodFor = new Map<string, string>();
  const seen = new Set<string>();
  for (
    let proto = target.prototype as object | null;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const value = Object.getOwnPropertyDescriptor(proto, name)?.value as
        | (Record<symbol, Marked | undefined> & ((...args: never[]) => unknown))
        | undefined;
      const marked = typeof value === 'function' ? value[MARK] : undefined;
      if (!marked) continue;

      const key = `${marked.kind}:${marked.message.action}`;
      const existing = methodFor.get(key);
      if (existing) {
        const [first, second] = [existing, name].sort();
        throw new TypeError(
          `${target.name} has two ${marked.kind === 'handlers' ? 'message' : 'event'} handlers for action "${marked.message.action}": ${first}() and ${second}(). Actions must be unique within a consumer.`,
        );
      }
      methodFor.set(key, name);
      methods.push({ name, ...marked });
    }
  }
  return methods;
}

/** A class's handlers, each calling its method on the instance serving the connection. */
export function handlersFromClass(target: abstract new (...args: never[]) => unknown) {
  const tables = {
    handlers: new Map<string, HandlerDefinition>(),
    events: new Map<string, HandlerDefinition>(),
  };
  for (const { name, kind, message, options } of handlerMethods(target)) {
    const { output, summary, description, tags } = options;
    tables[kind].set(message.action, {
      name: decamelizeKey(name),
      message,
      outputs: output === undefined ? [] : [output].flat(),
      summary,
      description,
      tags,
      handle: (incoming, ctx) =>
        (ctx.state as Record<string, (...args: unknown[]) => unknown>)[name]!(
          incoming,
          ctx,
        ),
    });
  }
  return tables;
}

/** What a class topic is built with: the subscription it serves. */
export interface Subscription<User = unknown> {
  readonly conn: Connection<string, User>;
  /** Params parsed from the topic: `room:{room_name}` subscribed as `room:lobby` gives `lobby`. */
  readonly params: Readonly<Record<string, string>>;
  /** The topic string, such as `room:lobby`. */
  readonly topic: string;
  push(message: Message): Promise<void>;
  publish(event: Message, options?: PublishOptions): Promise<void>;
}

/**
 * Base class for topics written as classes: set `static pattern`; the class name names its
 * layer group. One instance serves one subscription.
 */
export abstract class Topic<User = unknown> {
  /** The topic pattern, such as `room:{room_name}`. */
  static pattern: string;
  /** The AsyncAPI channel's description. */
  static description?: string;
  /** The channel layer to publish on. Defaults to `default`. */
  static layer?: string;
  /** Events forwarded to the client unchanged. */
  static passthrough?: readonly AnyMessageDefinition[];

  constructor(protected readonly subscription: Subscription<User>) {}

  get conn(): Connection<string, User> {
    return this.subscription.conn;
  }

  get params(): Readonly<Record<string, string>> {
    return this.subscription.params;
  }

  get topic(): string {
    return this.subscription.topic;
  }

  /** Send on this topic as a server push, without a `ref`. */
  push(message: Message): Promise<void> {
    return this.subscription.push(message);
  }

  /** Publish an event to everyone subscribed to this topic, across processes. */
  publish(event: Message, options?: PublishOptions): Promise<void> {
    return this.subscription.publish(event, options);
  }

  /** Decide whether this connection may subscribe. */
  authorize(): boolean | Promise<boolean> {
    return true;
  }

  /** Once subscribed; what it sends is state, not a reply. */
  onSubscribe(): void | Promise<void> {}

  /** Before leaving, on unsubscribe and on disconnect. */
  onUnsubscribe(): void | Promise<void> {}

  /** Override to change how a frame that failed validation is answered. */
  onValidationError?(
    issues: ValidationIssue[],
    ctx: TopicClassContext,
  ): void | Promise<void>;
  /** Override to change how a failing message handler is reported. */
  onHandlerError?(
    error: unknown,
    message: Message,
    ctx: TopicClassContext,
  ): void | Promise<void>;
  /** Override to change how a failing event handler is reported. */
  onEventError?(
    error: unknown,
    event: Message,
    ctx: TopicClassContext,
  ): void | Promise<void>;
}
