import type {
  BroadcastOptions,
  Connection,
  ConsumerDefinition,
  ConsumerOptions,
  Context,
  HandlerDefinition,
  HandlerOptions,
} from './consumer';
import { classDefinitions } from './consumer';
import type { AnyMessageDefinition, Message, MessageOf } from './messages';

/**
 * Base class for consumers written as classes, as chanx's `AsyncJsonWebsocketConsumer`.
 * One instance serves one connection, so its fields are per-connection state.
 */
export abstract class AsyncJsonWebsocketConsumer<User = unknown> {
  constructor(readonly conn: Connection<string, User>) {}

  get params(): Readonly<Record<string, string>> {
    return this.conn.params;
  }

  /** Send to this client as a server push, without a `ref`. */
  push(message: Message): Promise<void> {
    return this.conn.push(message);
  }

  /** Send to every connection in the groups, as Python's `broadcast_message`. */
  broadcast(message: Message, options?: BroadcastOptions): Promise<void> {
    return this.conn.broadcast(message, options);
  }

  /** After authentication, as Python's `post_authentication`. */
  onConnect(): void | Promise<void> {}

  onDisconnect(): void | Promise<void> {}
}

type ConsumerClass = abstract new (
  conn: Connection<string, any>,
) => AsyncJsonWebsocketConsumer<any>;

/** What a class consumer's handlers receive as their second argument. */
export type ClassContext = Context<string, AsyncJsonWebsocketConsumer<any>, any, Message>;

type OutputMessages<O> = [O] extends [never]
  ? never
  : MessageOf<O extends readonly (infer D)[] ? D : O>;
type Returned<O> = [O] extends [never] ? void | Message : OutputMessages<O>;
type Outputs = AnyMessageDefinition | readonly AnyMessageDefinition[];

type HandlerMethod<D, O> = (
  message: MessageOf<D>,
  ctx: ClassContext,
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

/** Handle a client message, as Python's `@ws_handler`. Return a declared output to reply. */
export function On<D extends AnyMessageDefinition, const O extends Outputs = never>(
  message: D,
  options: HandlerOptions<O> = {},
): MethodDecorator<HandlerMethod<D, O>> {
  return mark('handlers', message, options) as never;
}

/** Handle a server-side event from the channel layer, as Python's `@event_handler`. */
export function OnEvent<D extends AnyMessageDefinition, const O extends Outputs = never>(
  message: D,
  options: HandlerOptions<O> = {},
): MethodDecorator<HandlerMethod<D, O>> {
  return mark('events', message, options) as never;
}

export type ClassConsumerOptions = Omit<
  ConsumerOptions<string, unknown, unknown, AnyMessageDefinition>,
  'state' | 'onConnect' | 'onDisconnect'
> & {
  /** Events forwarded to the client unchanged, as Python's `passthrough_events`. */
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
  { passthrough = [], ...options }: ClassConsumerOptions,
): ConsumerDefinition {
  const handlers = new Map<string, HandlerDefinition>();
  const events = new Map<string, HandlerDefinition>();
  const methodFor = new Map<string, string>();
  const seen = new Set<string>();

  // Most derived first: an override, decorated or not, hides the method it overrides.
  for (
    let proto = target.prototype;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const value = Object.getOwnPropertyDescriptor(proto, name)?.value as
        | (Record<symbol, Marked | undefined> & ((...args: never[]) => unknown))
        | undefined;
      const marked = typeof value === 'function' ? value[MARK] : undefined;
      if (!marked) continue;

      const table = marked.kind === 'handlers' ? handlers : events;
      const key = `${marked.kind}:${marked.message.action}`;
      const existing = methodFor.get(key);
      if (existing) {
        const [first, second] = [existing, name].sort();
        throw new TypeError(
          `${target.name} has two ${marked.kind === 'handlers' ? 'message' : 'event'} handlers for action "${marked.message.action}": ${first}() and ${second}(). Actions must be unique within a consumer.`,
        );
      }
      methodFor.set(key, name);
      const { output, summary, description, tags } = marked.options;
      table.set(marked.message.action, {
        message: marked.message,
        outputs: output === undefined ? [] : [output].flat(),
        summary,
        description,
        tags,
        handle: (message, ctx) =>
          (ctx.state as Record<string, (...args: unknown[]) => unknown>)[name]!(
            message,
            ctx,
          ),
      });
    }
  }

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
    },
    handlers,
    events,
    passthrough,
  };
}
