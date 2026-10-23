import type { InferOutput, StandardSchemaV1 } from './standard-schema';

/** A chanx message on the wire: the `action` discriminant plus its payload. */
export interface Message<A extends string = string, P = unknown> {
  action: A;
  payload: P;
}

type CreateArgs<P> = [P] extends [null] ? [] : [payload: P];

/** A message type: its action, payload schema and AsyncAPI documentation. */
export interface MessageDefinition<A extends string = string, P = unknown> {
  /** The `action` discriminant on the wire. */
  readonly action: A;
  /** Validates the payload; `null` for a message that carries none. */
  readonly payload: StandardSchemaV1<unknown, P> | null;
  /** Its AsyncAPI component name. */
  readonly title: string;
  /** Documented in AsyncAPI. */
  readonly description?: string;
  /** Build a message of this type. The payload is typed, not validated. */
  create(...args: CreateArgs<P>): Message<A, P>;
}

/** Any message definition, whatever its action and payload. */
export interface AnyMessageDefinition extends Omit<MessageDefinition, 'create'> {
  create(...args: never): Message;
}

/** The message a definition creates: `MessageOf<typeof Chat>`. */
export type MessageOf<D> =
  D extends MessageDefinition<infer A, infer P> ? Message<A, P> : never;

/** Options for `defineMessage()`. */
export interface MessageOptions {
  /** The AsyncAPI component name. Defaults to `<Action>Message`, such as `ChatMessage`. */
  title?: string;
  /** Documented in AsyncAPI. */
  description?: string;
}

type PayloadSpec = StandardSchemaV1 | null;
type PayloadOf<S> = S extends StandardSchemaV1 ? InferOutput<S> : null;

/** A message with no payload, such as `defineMessage('ping')`. */
export function defineMessage<const A extends string>(
  action: A,
  options?: MessageOptions,
): MessageDefinition<A, null>;
/** A message whose payload any Standard Schema validates: Zod, Valibot, ArkType and others. */
export function defineMessage<const A extends string, S extends StandardSchemaV1>(
  action: A,
  payload: S,
  options?: MessageOptions,
): MessageDefinition<A, InferOutput<S>>;
export function defineMessage(
  action: string,
  payloadOrOptions?: StandardSchemaV1 | MessageOptions,
  options: MessageOptions = {},
): AnyMessageDefinition {
  const payload = isSchema(payloadOrOptions) ? payloadOrOptions : null;
  const { title = `${pascalCase(action)}Message`, description } = isSchema(
    payloadOrOptions,
  )
    ? options
    : (payloadOrOptions ?? {});
  return Object.freeze({
    action,
    payload,
    title,
    ...(description !== undefined && { description }),
    create: (...args: unknown[]) => ({ action, payload: args.length ? args[0] : null }),
  });
}

type MessageSpecs = Record<
  string,
  PayloadSpec | ({ payload: PayloadSpec } & MessageOptions)
>;

/** Several messages at once, each named by its key: `defineMessages({ chat: ChatPayload })`. */
export function defineMessages<const M extends MessageSpecs>(
  specs: M,
): {
  [K in keyof M & string]: MessageDefinition<
    K,
    M[K] extends { payload: infer S } ? PayloadOf<S> : PayloadOf<M[K]>
  >;
} {
  return Object.fromEntries(
    Object.entries(specs).map(([action, spec]) => {
      if (spec === null) return [action, defineMessage(action)];
      if (isSchema(spec)) return [action, defineMessage(action, spec)];
      const { payload, ...options } = spec;
      return [
        action,
        payload
          ? defineMessage(action, payload, options)
          : defineMessage(action, options),
      ];
    }),
  ) as never;
}

function isSchema(value: unknown): value is StandardSchemaV1 {
  return typeof value === 'object' && value !== null && '~standard' in value;
}

function pascalCase(action: string): string {
  return action
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join('');
}

/** Accepts any value. For built-ins whose payload chanx leaves open. */
function anything<T>(): StandardSchemaV1<T, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'chanx',
      validate: (value) => ({ value: value as T }),
    },
  };
}

export const PingMessage = defineMessage('ping', {
  description: 'Simple ping message to check WebSocket connection status.',
});
export const PongMessage = defineMessage('pong', {
  description: 'Simple pong message response to ping requests.',
});
export const ErrorMessage = defineMessage('error', anything<unknown>());
export const CompleteMessage = defineMessage('complete');
export const GroupCompleteMessage = defineMessage('group_complete');
export const EventCompleteMessage = defineMessage('event_complete');

export interface AuthenticationPayload {
  status_code: number;
  status_text: string;
  data: unknown;
}
export const AuthenticationMessage = defineMessage(
  'authentication',
  anything<AuthenticationPayload>(),
);
