import { Injectable, SetMetadata, applyDecorators } from '@nestjs/common';
import type { PipeTransform, Type } from '@nestjs/common';
import type {
  AnyMessageDefinition,
  ConsumerOptions,
  HandlerOptions,
  MessageOf,
} from '@chanx-js/server';
import { On as CoreOn, OnEvent as CoreOnEvent } from '@chanx-js/server';

export const CONSUMER = Symbol('chanx:consumer');
export const TOPIC = Symbol('chanx:topic');
// Nest's own key for handler parameters, shared with @nestjs/websockets' @MessageBody().
export const ROUTE_ARGS_METADATA = '__routeArguments__';
// @nestjs/websockets' WsParamtype values, so its decorators and ours mean the same.
export const SOCKET = 0;
export const PAYLOAD = 3;

export type ChanxConsumerOptions = Omit<
  ConsumerOptions<string, unknown, unknown, AnyMessageDefinition>,
  | 'state'
  | 'authenticate'
  | 'onConnect'
  | 'onDisconnect'
  | 'topics'
  | 'onValidationError'
  | 'onHandlerError'
  | 'onEventError'
> & {
  /** `@ChanxTopic` classes clients can subscribe to on this connection. */
  topics?: readonly Type[];
  /** Events forwarded to the client unchanged. */
  passthrough?: readonly AnyMessageDefinition[];
};

export interface ChanxTopicOptions {
  /** The layer group namespace. Defaults to the class name. */
  name?: string;
  description?: string;
  layer?: string;
  passthrough?: readonly AnyMessageDefinition[];
}

// Nest's SCOPE_OPTIONS_METADATA, which it does not export.
const SCOPE_OPTIONS = 'scope:options';

// Injectable, keeping a scope an @Injectable({ scope }) below already set: Nest's own
// Injectable() would reset it, and the explorer must see it to refuse a scoped gateway.
const gateway: ClassDecorator = (target) => {
  if (!Reflect.hasMetadata(SCOPE_OPTIONS, target)) Injectable()(target);
};

/** A chanx consumer as an injectable gateway on a route: its `@On` methods handle messages. */
export function ChanxConsumer(
  path: string,
  options: ChanxConsumerOptions,
): ClassDecorator {
  return applyDecorators(gateway, SetMetadata(CONSUMER, { path, options }));
}

/** A chanx topic as an injectable gateway, mounted through a consumer's `topics`. */
export function ChanxTopic(
  pattern: string,
  options: ChanxTopicOptions = {},
): ClassDecorator {
  return applyDecorators(gateway, SetMetadata(TOPIC, { pattern, options }));
}

type Outputs = AnyMessageDefinition | readonly AnyMessageDefinition[];
type OutputMessages<O> = [O] extends [never]
  ? never
  : MessageOf<O extends readonly (infer D)[] ? D : O>;
type Returned<O> = [O] extends [never] ? unknown : void | OutputMessages<O>;

// Parameters come from `@Payload()` and `@Ctx()`, so only the reply is checked.
type HandlerDecorator<O> = <
  M extends (...args: any[]) => Returned<O> | Promise<Returned<O>>,
>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<M>,
) => void;

/** Handle a client message. `output` declares what it returns or broadcasts. */
export function On<D extends AnyMessageDefinition, const O extends Outputs = never>(
  message: D,
  options?: HandlerOptions<O>,
): HandlerDecorator<O> {
  return CoreOn(message, options) as unknown as HandlerDecorator<O>;
}

/** Handle a server-side event from the channel layer. */
export function OnEvent<D extends AnyMessageDefinition, const O extends Outputs = never>(
  message: D,
  options?: HandlerOptions<O>,
): HandlerDecorator<O> {
  return CoreOnEvent(message, options) as unknown as HandlerDecorator<O>;
}

function routeParam(type: number, data?: string, pipes: Pipe[] = []) {
  return (target: object, key: string | symbol | undefined, index: number) => {
    const existing =
      Reflect.getMetadata(ROUTE_ARGS_METADATA, target.constructor, key!) ?? {};
    Reflect.defineMetadata(
      ROUTE_ARGS_METADATA,
      { ...existing, [`${type}:${index}`]: { index, data, pipes } },
      target.constructor,
      key!,
    );
  };
}

type Pipe = Type<PipeTransform> | PipeTransform;

/**
 * The message's payload, or one of its properties, through any pipes, as `@MessageBody()`:
 * `@Payload()`, `@Payload('text')`, `@Payload(new ValidationPipe())`.
 */
export function Payload(...pipes: Pipe[]): ParameterDecorator;
export function Payload(property: string, ...pipes: Pipe[]): ParameterDecorator;
export function Payload(
  propertyOrPipe?: string | Pipe,
  ...pipes: Pipe[]
): ParameterDecorator {
  return typeof propertyOrPipe === 'string' || propertyOrPipe === undefined
    ? routeParam(PAYLOAD, propertyOrPipe, pipes)
    : routeParam(PAYLOAD, undefined, [propertyOrPipe, ...pipes]);
}

/** The chanx context: the connection, the `ref`-stamped `send()`, the topic. */
export function Ctx(): ParameterDecorator {
  return routeParam(SOCKET);
}
