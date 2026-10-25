import type { ChannelLayer, ChannelMessage, LayerChannel } from '@chanx-js/layers';
import {
  ENVELOPE_VERSION,
  TopicErrorReason,
  formatPattern,
  safeGroupName,
} from '@chanx-js/protocol';

import type { Logger, ResolvedOptions, Transport } from './app';
import { camelize, decamelize } from './case';
import type {
  BroadcastOptions,
  ConnectRequest,
  Connection,
  ConsumerDefinition,
  ErrorHooks,
  HandlerDefinition,
} from './consumer';
import { eventHandlersOf } from './consumer';
import { AuthenticationError } from './errors';
import type { Message } from './messages';
import {
  AuthenticationMessage,
  CompleteMessage,
  ErrorMessage,
  EventCompleteMessage,
  GroupCompleteMessage,
} from './messages';
import type { PublishOptions, TopicDefinition } from './topic';
import { topicDefinitionOf, topicsOf } from './topic';
import type { ValidationResult } from './validation';
import { createValidator, envelopeIssues, isObject } from './validation';

/** A binary WebSocket frame, in whichever form the runtime delivers it. */
export type BinaryFrame = ArrayBufferLike | ArrayBufferView | Blob;

/** One accepted socket, as an adapter drives it. */
export interface Session {
  /** Resolves once connected (authenticated, groups joined, `onConnect` run), or false if not. */
  readonly ready: Promise<boolean>;
  /** A frame from the client. Binary frames are answered with an error, as chanx does. */
  receive(data: string | BinaryFrame): void;
  /** The socket closed, by either side. Resolves once `onDisconnect` ran and groups are left. */
  closed(): Promise<void>;
}

// The layer message types chanx consumers dispatch on, so Python and Node share them.
export const CHANNEL_EVENT = 'handle_channel_event';
export const GROUP_MESSAGE = 'handle_group_message';
export const TOPIC_EVENT = 'handle_topic_event';

/** The channel layer group a topic's subscribers join, as chanx's `Topic.group_name`. */
export function topicGroup(topic: TopicDefinition, value: string): string {
  return safeGroupName([value], { namespace: topic.name });
}

type Envelope = { topic?: string; ref?: string; seq?: number };

/** Handlers and what they run with: the consumer itself, or one topic subscription. */
interface Scope {
  readonly hooks: ErrorHooks<never>;
  readonly handlers: ReadonlyMap<string, HandlerDefinition>;
  readonly events: ReadonlyMap<string, HandlerDefinition>;
  validate(frame: Record<string, unknown>): Promise<ValidationResult>;
  validateEvent(frame: Record<string, unknown>): Promise<ValidationResult>;
  context(envelope: Envelope): object;
}

interface Subscription {
  readonly topic: TopicDefinition;
  readonly group: string;
  readonly scope: Scope;
}

const scopes = new WeakMap<
  object,
  Pick<Scope, 'handlers' | 'events' | 'validate' | 'validateEvent'>
>();

function handlersOf(definition: ConsumerDefinition | TopicDefinition) {
  let found = scopes.get(definition);
  if (!found) {
    const events = eventHandlersOf(definition);
    found = {
      handlers: definition.handlers,
      events,
      validate: createValidator([...definition.handlers.values()].map((h) => h.message)),
      validateEvent: createValidator([...events.values()].map((h) => h.message)),
    };
    scopes.set(definition, found);
  }
  return found;
}

// As chanx: 4000 + a 4xx or 5xx status, so a client can tell a refusal from a drop.
export function authenticationCloseCode(status: number): number {
  return status >= 400 && status < 600 ? 4000 + status : 4401;
}

export type AuthenticationResult =
  | { user: unknown }
  | { status: number; statusText: string; data: unknown }
  | { crashed: unknown };

/** Run a consumer's authenticate, as the `authentication` message and an HTTP refusal report it. */
export async function authenticateRequest(
  consumer: { authenticate?: (request: never) => unknown },
  request: ConnectRequest,
  logger: Logger,
): Promise<AuthenticationResult> {
  try {
    const user = await (consumer.authenticate as (request: ConnectRequest) => unknown)(
      request,
    );
    if (user === false || user === null || user === undefined) {
      return {
        status: 401,
        statusText: 'Unauthorized',
        data: { detail: 'Authentication credentials were not provided.' },
      };
    }
    return { user };
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return { status: error.status, statusText: error.statusText, data: error.data };
    }
    logger.error('chanx: authentication raised', error);
    return { crashed: error };
  }
}
export function openSession(
  definition: ConsumerDefinition,
  request: ConnectRequest,
  transport: Transport,
  options: ResolvedOptions & { layer: ChannelLayer },
  authenticated?: { user: unknown },
): Session {
  const { logger, layer } = options;
  const consumer = definition.options;
  const abort = new AbortController();
  const warned = new Set<string>();
  const groups: string[] = [];
  const subscriptions = new Map<string, Subscription>();
  const topics = topicsOf(definition);
  let channel: LayerChannel | undefined;
  let defaultTopic: string | undefined;
  let isClosed = false;
  let connected = false;
  let state: unknown;
  let teardown = Promise.resolve();

  const requireChannel = () => {
    if (!channel)
      throw new Error('The connection has no layer channel until it is authenticated');
    return channel;
  };

  // Built on the request object itself: authenticate, before or after the upgrade, gets
  // the very object every hook later sees as ctx.conn.
  const conn = Object.defineProperties(
    request,
    Object.getOwnPropertyDescriptors({
      id: crypto.randomUUID(),
      user: undefined,
      get channelName() {
        return requireChannel().name;
      },
      groups,
      async join(group: string) {
        if (isClosed || groups.includes(group)) return;
        await layer.groupAdd(group, requireChannel().name);
        groups.push(group);
      },
      async leave(group: string) {
        const index = groups.indexOf(group);
        if (index === -1) return;
        groups.splice(index, 1);
        await layer.groupDiscard(group, requireChannel().name);
      },
      push: async (message: Message) => write(message, {}),
      broadcast: (message: Message, options?: BroadcastOptions) =>
        broadcast(message, options),
      close(code?: number, reason?: string) {
        if (isClosed) return;
        isClosed = true;
        transport.close(code, reason);
      },
    } satisfies Omit<Connection<string, unknown>, keyof ConnectRequest>),
  ) as Connection<string, unknown>;

  const write = (message: object, envelope: Envelope) => {
    if (isClosed) return;
    const content = options.camelize ? (camelize(message) as object) : message;
    // A plain frame without a ref gets no envelope at all, as chanx sends it.
    const stamped =
      envelope.topic !== undefined
        ? { ...content, version: ENVELOPE_VERSION, ...envelope }
        : envelope.ref !== undefined
          ? { ...content, version: ENVELOPE_VERSION, ref: envelope.ref }
          : content;
    transport.send(JSON.stringify(stamped));
  };

  async function broadcast(
    message: Message,
    { groups: targets = groups, excludeCurrent = false }: BroadcastOptions = {},
  ) {
    const from = requireChannel().name;
    await Promise.all(
      targets.map((group) =>
        layer.groupSend(group, {
          type: GROUP_MESSAGE,
          message,
          exclude_current: excludeCurrent,
          from_channel: from,
        }),
      ),
    );
  }

  const consumerScope: Scope = {
    hooks: consumer,
    ...handlersOf(definition),
    context: (envelope) => ({
      conn,
      params: request.params,
      state,
      ref: envelope.ref,
      signal: abort.signal,
      send: async (message: Message) => write(message, envelope),
      push: async (message: Message) => write(message, {}),
      broadcast,
    }),
  };

  function publisher(topic: TopicDefinition, value: string) {
    const group = topicGroup(topic, value);
    return (event: Message, { seq }: PublishOptions = {}) =>
      layer.groupSend(group, {
        type: TOPIC_EVENT,
        topic: value,
        seq: seq ?? null,
        event_data: event,
      });
  }

  function topicScope(
    topic: TopicDefinition,
    value: string,
    params: Record<string, string>,
    state: unknown,
    publish: ReturnType<typeof publisher>,
  ): Scope {
    return {
      hooks: topic.options,
      ...handlersOf(topic),
      context: (envelope) => ({
        conn,
        params,
        topic: value,
        state,
        ref: envelope.ref,
        signal: abort.signal,
        send: async (message: Message) => write(message, envelope),
        push: async (message: Message) => write(message, { topic: value }),
        publish,
      }),
    };
  }

  const ready = (async () => {
    if (authenticated) {
      (conn as { user: unknown }).user = authenticated.user;
      replyAuthentication(200, 'OK', { detail: 'OK' });
    } else if (consumer.authenticate) {
      const refused = await authenticate();
      if (refused) {
        conn.close(refused);
        return false;
      }
    }
    channel = await layer.newChannel(onLayerMessage);
    if (abort.signal.aborted) {
      await channel.close();
      return false;
    }
    state = consumer.state?.(conn);
    const initial =
      typeof consumer.groups === 'function' ? consumer.groups(conn) : consumer.groups;
    for (const group of initial ?? []) await conn.join(group);
    connected = true;
    await consumer.onConnect?.(consumerScope.context({}) as never);
    if (definition.defaultTopic) {
      // A route dedicated to one topic subscribes it from the URL, as chanx's default topic.
      const { pattern } = topicDefinitionOf(definition.defaultTopic);
      defaultTopic = formatPattern(pattern, request.params);
      await subscribe(defaultTopic, { topic: defaultTopic });
    }
    return true;
  })().catch((error: unknown) => {
    logger.error('chanx: connecting failed', error);
    conn.close(1011);
    return false;
  });

  function replyAuthentication(status_code: number, status_text: string, data: unknown) {
    write(AuthenticationMessage.create({ status_code, status_text, data }), {});
  }

  async function authenticate(): Promise<number | undefined> {
    const result = await authenticateRequest(consumer, conn, logger);
    if ('user' in result) {
      (conn as { user: unknown }).user = result.user;
      replyAuthentication(200, 'OK', { detail: 'OK' });
      return undefined;
    }
    // As chanx: an unexpected failure is logged and the client told nothing.
    if ('crashed' in result) return authenticationCloseCode(500);
    replyAuthentication(result.status, result.statusText, result.data);
    return authenticationCloseCode(result.status);
  }

  async function handleFrame(data: string | BinaryFrame) {
    if (!(await ready) || isClosed) return;

    const rejectFrame = (reason: string) => {
      logger.warn('chanx: malformed frame', reason);
      write(
        ErrorMessage.create([
          { type: 'json_invalid', loc: [], msg: `Invalid JSON: ${reason}` },
        ]),
        {},
      );
    };
    if (typeof data !== 'string') return rejectFrame('binary frames are not supported');
    let content: unknown;
    try {
      content = JSON.parse(data);
    } catch (error) {
      return rejectFrame((error as SyntaxError).message);
    }
    const issues = envelopeIssues(content);
    if (issues.length) return void write(ErrorMessage.create(issues), {});

    // Checked above: topic and ref are strings, null or absent.
    const { version, topic, ref, seq, ...rest } = content as Record<string, unknown>;
    const envelope: Envelope = {
      ref: (ref as string | null) ?? undefined,
      topic: (topic as string | null) ?? defaultTopic,
    };
    const message = (options.camelize ? decamelize(rest) : rest) as Record<
      string,
      unknown
    >;

    if (envelope.topic === undefined) return runMessage(consumerScope, message, envelope);
    if (message.action === 'subscribe') return subscribe(envelope.topic, envelope);
    if (message.action === 'unsubscribe') return unsubscribe(envelope.topic, envelope);
    const subscription = subscriptions.get(envelope.topic);
    if (!subscription) {
      return topicError(
        TopicErrorReason.NOT_SUBSCRIBED,
        `Not subscribed to '${envelope.topic}'`,
        envelope,
      );
    }
    await runMessage(subscription.scope, message, envelope);
  }

  async function runMessage(
    scope: Scope,
    frame: Record<string, unknown>,
    envelope: Envelope,
  ) {
    await handleMessage(scope, frame, envelope);
    if (options.sendCompletion) write(CompleteMessage.create(), envelope);
  }

  async function handleMessage(
    scope: Scope,
    frame: Record<string, unknown>,
    envelope: Envelope,
  ) {
    if (scope.handlers.size === 0) {
      logger.error(`chanx: consumer "${consumer.name}" has no message handlers`);
      return write(
        ErrorMessage.create({ detail: 'Failed to process message' }),
        envelope,
      );
    }
    const ctx = scope.context(envelope) as never;
    const result = await scope.validate(frame);
    if ('issues' in result) {
      const {
        onValidationError = () => write(ErrorMessage.create(result.issues), envelope),
      } = scope.hooks;
      return hook(() => onValidationError(result.issues, ctx));
    }

    const { message } = result;
    const handler = scope.handlers.get(message.action)!;
    try {
      const reply = await handler.handle(message, ctx);
      if (reply !== undefined) {
        checkDeclared(handler, reply);
        write(reply as object, envelope);
      }
    } catch (error) {
      const {
        onHandlerError = () => {
          logger.error(`chanx: handler for "${message.action}" failed`, error);
          write(
            ErrorMessage.create({
              detail: `Failed to process message for ${message.action}`,
            }),
            envelope,
          );
        },
      } = scope.hooks;
      await hook(() => onHandlerError(error, message, ctx));
    }
  }

  function topicError(reason: TopicErrorReason, detail: string, envelope: Envelope) {
    logger.warn('chanx: topic error', { topic: envelope.topic, reason, detail });
    write(ErrorMessage.create({ reason, detail }), envelope);
  }

  async function subscribe(value: string, envelope: Envelope) {
    const subscribed = { action: 'subscribed', payload: null };
    if (subscriptions.has(value)) return write(subscribed, envelope);

    const found = topics
      .map((topic) => ({ topic, params: topic.match(value) }))
      .find(({ params }) => params !== null);
    if (!found)
      return topicError(
        TopicErrorReason.UNKNOWN_TOPIC,
        `Unknown topic '${value}'`,
        envelope,
      );
    const { topic } = found;
    const params = found.params!;
    const publish = publisher(topic, value);
    const state = topic.options.state?.({
      conn,
      params,
      topic: value,
      push: async (message) => write(message, { topic: value }),
      publish,
    });
    const authorized =
      (await topic.options.authorize?.({ params, conn, topic: value, state })) ?? true;
    if (!authorized) {
      return topicError(
        TopicErrorReason.UNAUTHORIZED,
        `Not allowed to subscribe to '${value}'`,
        envelope,
      );
    }

    const scope = topicScope(topic, value, params, state, publish);
    const group = topicGroup(topic, value);
    await layer.groupAdd(group, requireChannel().name);
    groups.push(group);
    subscriptions.set(value, { topic, group, scope });
    write(subscribed, envelope);
    // What the topic pushes now is state, not a reply to the subscribe.
    await topic.options.onSubscribe?.(scope.context({ topic: value }) as never);
  }

  async function unsubscribe(value: string, envelope: Envelope) {
    const subscription = subscriptions.get(value);
    if (subscription) await leaveTopic(value, subscription);
    write({ action: 'unsubscribed', payload: null }, envelope);
  }

  async function leaveTopic(value: string, { topic, group, scope }: Subscription) {
    subscriptions.delete(value);
    await topic.options.onUnsubscribe?.(scope.context({ topic: value }) as never);
    groups.splice(groups.indexOf(group), 1);
    if (channel) await layer.groupDiscard(group, channel.name);
  }

  // Layer messages wait for the connection to be ready, as chanx queues them behind connect.
  function onLayerMessage(message: ChannelMessage) {
    void (async () => {
      if (!(await ready) || isClosed) return;
      if (message.type === GROUP_MESSAGE) return handleGroupMessage(message);
      if (message.type === CHANNEL_EVENT)
        return handleEvent(consumerScope, message.event_data, {});
      if (message.type === TOPIC_EVENT) {
        const value = String(message.topic);
        const subscription = subscriptions.get(value);
        if (!subscription) return;
        const seq = typeof message.seq === 'number' ? message.seq : undefined;
        return handleEvent(subscription.scope, message.event_data, { topic: value, seq });
      }
      logger.warn(`chanx: ignored a layer message of type "${String(message.type)}"`);
    })().catch((error: unknown) => logger.error('chanx: layer message failed', error));
  }

  function handleGroupMessage(message: ChannelMessage) {
    if (message.exclude_current && message.from_channel === channel?.name) return;
    if (!isObject(message.message)) {
      return logger.error('chanx: group message carries no message', message);
    }
    write(message.message, {});
    if (options.sendCompletion) write(GroupCompleteMessage.create(), {});
  }

  async function handleEvent(scope: Scope, data: unknown, envelope: Envelope) {
    if (scope.events.size === 0) {
      return logger.error(`chanx: consumer "${consumer.name}" has no event handlers`);
    }
    if (!isObject(data)) return logger.error('chanx: channel event is not a dict', data);
    const result = await scope.validateEvent(data);
    if ('issues' in result) {
      return logger.error('chanx: channel event failed validation', result.issues);
    }

    const { message } = result;
    const handler = scope.events.get(message.action)!;
    const ctx = scope.context(envelope) as never;
    try {
      const reply = await handler.handle(message, ctx);
      if (reply !== undefined) {
        checkDeclared(handler, reply);
        write(reply as object, envelope);
      }
    } catch (error) {
      const {
        onEventError = () =>
          logger.error(`chanx: event handler for "${message.action}" failed`, error),
      } = scope.hooks;
      await hook(() => onEventError(error, message, ctx));
    }
    if (options.sendCompletion) write(EventCompleteMessage.create(), envelope);
  }

  /** Run a user's error hook; one that throws is logged, never left to escape. */
  async function hook(run: () => void | Promise<void>) {
    try {
      await run();
    } catch (error) {
      logger.error('chanx: error hook failed', error);
    }
  }

  function checkDeclared(handler: HandlerDefinition, reply: unknown) {
    if (!options.dev || !isObject(reply)) return;
    const action = String(reply.action);
    if (handler.outputs.some((output) => output.action === action)) return;
    const key = `${handler.message.action}->${action}`;
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(
      `chanx: ${handler.message.action} returned "${action}" but does not declare it as an output; AsyncAPI won't list it.`,
    );
  }

  return {
    ready,
    receive(data) {
      // Each frame runs on its own, as chanx runs each in a task: a slow one blocks none.
      void handleFrame(data).catch((error: unknown) =>
        logger.error('chanx: frame failed', error),
      );
    },
    closed() {
      if (abort.signal.aborted) return teardown;
      isClosed = true;
      abort.abort();
      // Topics leave first, then the hook runs, then the groups go: chanx's order.
      teardown = (async () => {
        for (const [value, subscription] of [...subscriptions])
          await leaveTopic(value, subscription);
        if (connected) await consumer.onDisconnect?.(consumerScope.context({}) as never);
        await channel?.close();
      })().catch((error: unknown) => logger.error('chanx: disconnecting failed', error));
      return teardown;
    },
  };
}
