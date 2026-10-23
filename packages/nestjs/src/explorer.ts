import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnModuleInit,
  type Type,
} from '@nestjs/common';
import {
  ContextIdFactory,
  DiscoveryService,
  ExternalContextCreator,
  HttpAdapterHost,
  ModuleRef,
} from '@nestjs/core';
import type { ContextId } from '@nestjs/core';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ParamsFactory } from '@nestjs/core/helpers/external-context-creator.js';
import type {
  Chanx,
  ConsumerBuilder,
  ErrorHooks,
  Message,
  TopicBuilder,
} from '@chanx-js/server';
import {
  ErrorMessage,
  consumer,
  createChanx,
  handlerMethods,
  topic,
} from '@chanx-js/server';
import type { Attachment } from '@chanx-js/server/node';
import { asyncapiMiddleware, attachChanx } from '@chanx-js/server/node';

import type { ChanxConsumerOptions, ChanxTopicOptions } from './decorators';
import { CONSUMER, PAYLOAD, ROUTE_ARGS_METADATA, SOCKET, TOPIC } from './decorators';
import type { ChanxModuleOptions } from './options';
import { CHANX_OPTIONS } from './options';
import { ChanxService } from './service';

type Gateway = Record<string, ((...args: unknown[]) => unknown) | undefined>;
// A gateway's message types live in its decorators, not its class type.
type AnyConsumerBuilder = ConsumerBuilder<string, unknown, unknown, Message, Message>;
type AnyTopicBuilder = TopicBuilder<string, unknown, unknown, Message, Message>;
type Hook = (...args: any[]) => void | Promise<void>;
type RawOr<T> = T | { raw: T };
const unwrap = <T extends object>(value: RawOr<T>): T =>
  'raw' in value ? value.raw : value;
type Register<B> = (...args: any[]) => B;
type Run = (...args: unknown[]) => Promise<unknown>;
type Scoped = { conn: object; state: unknown };

/** A gateway's class, with its one instance unless Nest resolves it per connection. */
interface GatewayRef {
  readonly type: Type;
  readonly instance?: Gateway;
}

// What @Payload() and @Ctx() (or @MessageBody() and @ConnectedSocket()) receive: handlers
// are called with (ctx, payload), the order of Nest's (client, data).
const paramsFactory: ParamsFactory = {
  exchangeKeyForValue(type, data, args) {
    if (type === SOCKET) return args[0];
    if (type !== PAYLOAD) return null;
    const payload = args[1] as Record<string, unknown> | null | undefined;
    return data ? payload?.[data as string] : payload;
  },
};

/** Finds the `@ChanxConsumer` and `@ChanxTopic` gateways at bootstrap and serves them. */
@Injectable()
export class ChanxExplorer
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('Chanx');
  private attachment?: Attachment;
  private app?: Chanx;
  // Request-scoped gateways get a Nest context per connection, or per subscription for a
  // topic, with the connection as REQUEST.
  private readonly connectionGateways = new WeakMap<object, Promise<Gateway>>();
  private readonly contextOf = new WeakMap<Gateway, ContextId>();
  private readonly runs = new WeakMap<Gateway, Map<string, Run>>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly adapterHost: HttpAdapterHost,
    private readonly contextCreator: ExternalContextCreator,
    @Inject(CHANX_OPTIONS) private readonly options: ChanxModuleOptions,
    private readonly service: ChanxService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    const gateways = this.discovery
      .getProviders()
      .filter(({ metatype }) => metatype && isGateway(metatype))
      .map((wrapper): GatewayRef => {
        const type = wrapper.metatype as Type;
        if (wrapper.isTransient) {
          throw new Error(
            `${type.name} is transient: a gateway serves connections, so make it a ` +
              'singleton, or request-scoped for an instance per connection.',
          );
        }
        return wrapper.isDependencyTreeStatic()
          ? { type, instance: wrapper.instance as Gateway }
          : { type };
      });

    const topics = new Map<Type, AnyTopicBuilder>();
    for (const gateway of gateways) {
      const metadata = Reflect.getMetadata(TOPIC, gateway.type) as
        { pattern: string; options: ChanxTopicOptions } | undefined;
      if (metadata) topics.set(gateway.type, this.topic(gateway, metadata));
    }
    const consumers = new Map<Type, AnyConsumerBuilder>();
    for (const gateway of gateways) {
      const metadata = Reflect.getMetadata(CONSUMER, gateway.type) as
        { path: string; options: ChanxConsumerOptions } | undefined;
      if (metadata) consumers.set(gateway.type, this.consumer(gateway, metadata, topics));
    }

    const { pingInterval, asyncapi: _asyncapi, ...options } = this.options;
    const app = createChanx({
      logger: this.logger,
      ...options,
      consumers: [...consumers.values()],
    });
    this.app = app;
    this.service.attach(app, new Map<Type, object>([...consumers, ...topics]));
    const server = this.adapterHost.httpAdapter?.getHttpServer();
    if (server) this.attachment = attachChanx(server, app, { pingInterval });
  }

  // Routes go in now: Nest adds its not-found handler after init, before bootstrap.
  onModuleInit(): void {
    const { asyncapi } = this.options;
    const adapter = this.adapterHost.httpAdapter;
    if (!asyncapi || !adapter) return;
    const options = asyncapi === true ? {} : asyncapi;
    const path = options.path ?? '/asyncapi';
    let serve: ReturnType<typeof asyncapiMiddleware> | undefined;
    // Express passes Node's request and response; Fastify wraps them, as `raw`.
    const handler = (
      request: RawOr<IncomingMessage>,
      response: RawOr<ServerResponse> & { hijack?(): void },
      next?: () => void,
    ) => {
      if (!this.app) return void next?.();
      // Fastify's rule for writing to the raw response: hijack the reply first.
      response.hijack?.();
      serve ??= asyncapiMiddleware(this.app, options);
      serve(unwrap(request), unwrap(response), next);
    };
    for (const route of [path, `${path}.json`, `${path}.yaml`]) {
      adapter.get(route, (request, response, next) =>
        handler(request, response, next && (() => next())),
      );
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.attachment?.close();
  }

  private consumer(
    gateway: GatewayRef,
    { path, options }: { path: string; options: ChanxConsumerOptions },
    topics: Map<Type, AnyTopicBuilder>,
  ) {
    const { topics: topicTypes = [], passthrough = [], ...rest } = options;
    // authenticate gets the connection itself; every other hook has it as ctx.conn.
    const hook = (
      name: string,
      connIn = (args: unknown[]) => (args.at(-1) as Scoped).conn,
    ) =>
      this.hook(gateway, name, (args) => this.connectionGateway(gateway, connIn(args)));
    let builder = consumer(path, {
      ...rest,
      topics: topicTypes.map((topicType) => {
        const source = topics.get(topicType);
        if (!source) throw new Error(`${topicType.name} is not a @ChanxTopic provider`);
        return source;
      }),
      authenticate: hook('authenticate', (args) => args[0] as object),
      onConnect: hook('onConnect'),
      onDisconnect: hook('onDisconnect'),
      ...this.errorHooks((name) => hook(name)),
    } as never) as AnyConsumerBuilder;
    builder = this.addHandlers(builder, gateway, (ctx) =>
      this.connectionGateway(gateway, ctx.conn),
    );
    return passthrough.length ? builder.passthrough(...passthrough) : builder;
  }

  private topic(
    gateway: GatewayRef,
    { pattern, options }: { pattern: string; options: ChanxTopicOptions },
  ) {
    const { passthrough = [], name = gateway.type.name, ...rest } = options;
    // A request-scoped topic gets an instance per subscription, as its state.
    const hook = (name: string) =>
      this.hook(
        gateway,
        name,
        (args) => (args.at(-1) as Scoped).state as Promise<Gateway>,
      );
    let builder = topic(pattern, {
      ...rest,
      name,
      ...(!gateway.instance && {
        state: ({ conn }: { conn: object }) => this.resolve(gateway.type, conn),
      }),
      authorize: hook('authorize'),
      onSubscribe: hook('onSubscribe'),
      onUnsubscribe: hook('onUnsubscribe'),
      ...this.errorHooks(hook),
    } as never) as AnyTopicBuilder;
    builder = this.addHandlers(builder, gateway, (ctx) => ctx.state as Promise<Gateway>);
    return passthrough.length ? builder.passthrough(...passthrough) : builder;
  }

  private addHandlers<B extends { on: Register<B>; event: Register<B> }>(
    builder: B,
    gateway: GatewayRef,
    instanceIn: (ctx: Scoped) => Gateway | Promise<Gateway>,
  ): B {
    for (const { name, kind, message, options } of handlerMethods(gateway.type)) {
      const handle = async (incoming: Message, ctx: Scoped) => {
        const instance = gateway.instance ?? (await instanceIn(ctx));
        return this.run(
          instance,
          name,
          this.contextOf.get(instance),
        )(ctx, incoming.payload);
      };
      builder = builder[kind === 'handlers' ? 'on' : 'event'](
        message,
        { name, ...options },
        handle,
      );
    }
    return builder;
  }

  // Nest's guards, interceptors, pipes and filters around one gateway method.
  private run(instance: Gateway, name: string, contextId?: ContextId): Run {
    let byName = this.runs.get(instance);
    if (!byName) this.runs.set(instance, (byName = new Map()));
    let run = byName.get(name);
    if (!run) {
      run = this.contextCreator.create(
        instance,
        instance[name]!,
        name,
        ROUTE_ARGS_METADATA,
        paramsFactory,
        contextId,
        undefined,
        undefined,
        'ws',
      ) as Run;
      byName.set(name, run);
    }
    return run;
  }

  private async resolve(type: Type, conn: object): Promise<Gateway> {
    const contextId = ContextIdFactory.create();
    this.moduleRef.registerRequestByContextId(conn, contextId);
    const instance = await this.moduleRef.resolve<Gateway>(type, contextId, {
      strict: false,
    });
    this.contextOf.set(instance, contextId);
    return instance;
  }

  private connectionGateway(
    gateway: GatewayRef,
    conn: object,
  ): Gateway | Promise<Gateway> {
    if (gateway.instance) return gateway.instance;
    let instance = this.connectionGateways.get(conn);
    if (!instance) {
      instance = this.resolve(gateway.type, conn);
      this.connectionGateways.set(conn, instance);
    }
    return instance;
  }

  // A gateway method as a chanx hook, or undefined when the gateway has none.
  private hook(
    gateway: GatewayRef,
    name: string,
    instanceIn: (args: unknown[]) => Gateway | Promise<Gateway>,
  ): Hook | undefined {
    if (typeof (gateway.type.prototype as Gateway)[name] !== 'function') return undefined;
    if (gateway.instance) return this.method(gateway.instance, name);
    return async (...args: unknown[]) => {
      const instance = await instanceIn(args);
      return instance[name]!(...args) as void;
    };
  }

  private method(instance: Gateway, name: string): Hook | undefined {
    const method = instance[name];
    return typeof method === 'function' ? (method.bind(instance) as Hook) : undefined;
  }

  private errorHooks(
    hook: (name: string) => Hook | undefined,
  ): ErrorHooks<{ send(message: Message): Promise<void> }> {
    return {
      onValidationError: hook('onValidationError'),
      onEventError: hook('onEventError'),
      onHandlerError:
        hook('onHandlerError') ??
        ((error, message, ctx) => {
          // Nest's exceptions, a guard's ForbiddenException or a pipe's BadRequestException
          // among them, are meant for the client: chanx sends `detail`, so they do too.
          if (error instanceof HttpException) {
            return ctx.send(
              ErrorMessage.create({
                detail: error.getResponse(),
                status_code: error.getStatus(),
              }),
            );
          }
          if (isWsException(error)) {
            return ctx.send(ErrorMessage.create({ detail: error.getError() }));
          }
          this.logger.error(`Handler for "${message.action}" failed`, error as Error);
          return ctx.send(
            ErrorMessage.create({
              detail: `Failed to process message for ${message.action}`,
            }),
          );
        }),
    };
  }
}

// Matched by class name so `@nestjs/websockets` stays optional; WsException sets no `name`.
function isWsException(error: unknown): error is { getError(): unknown } {
  for (let proto = error; proto; proto = Object.getPrototypeOf(proto)) {
    if (proto.constructor?.name === 'WsException') return true;
  }
  return false;
}

function isGateway(type: object): boolean {
  return Reflect.hasMetadata(CONSUMER, type) || Reflect.hasMetadata(TOPIC, type);
}
