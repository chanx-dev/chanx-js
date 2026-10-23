import type { ChannelLayer, ChannelMessage, LayerChannel } from '@chanx-js/layers';
import { ENVELOPE_VERSION, TopicErrorReason } from '@chanx-js/protocol';

import type { ResolvedOptions, Transport } from './app';
import { camelize, decamelize } from './case';
import type {
  ConnectRequest,
  Connection,
  ConsumerDefinition,
  Context,
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
import { createValidator, envelopeIssues, isObject } from './validation';

/** One accepted socket, as an adapter drives it. */
export interface Session {
  /** Resolves once connected (authenticated, groups joined, `onConnect` run), or false if not. */
  readonly ready: Promise<boolean>;
  /** A text frame from the client. */
  receive(data: string): void;
  /** The socket closed, by either side. Resolves once `onDisconnect` ran and groups are left. */
  closed(): Promise<void>;
}

// The layer message types chanx consumers dispatch on, so Python and Node share them.
export const CHANNEL_EVENT = 'handle_channel_event';
export const GROUP_MESSAGE = 'handle_group_message';

type Envelope = { topic?: string; ref?: string };

export function openSession(
  definition: ConsumerDefinition,
  request: ConnectRequest,
  transport: Transport,
  options: ResolvedOptions & { layer: ChannelLayer },
): Session {
  const { logger, layer } = options;
  const consumer = definition.options;
  const abort = new AbortController();
  const validate = createValidator(
    [...definition.handlers.values()].map((h) => h.message),
  );
  const eventHandlers = eventHandlersOf(definition);
  const validateEvent = createValidator(
    [...eventHandlers.values()].map((h) => h.message),
  );
  const warned = new Set<string>();
  const groups: string[] = [];
  let channel: LayerChannel | undefined;
  let isClosed = false;
  let connected = false;
  let state: unknown;
  let teardown = Promise.resolve();

  const requireChannel = () => {
    if (!channel)
      throw new Error('The connection has no layer channel until it is authenticated');
    return channel;
  };

  const conn: Connection<string, unknown> = {
    ...request,
    id: crypto.randomUUID(),
    user: undefined,
    get channelName() {
      return requireChannel().name;
    },
    groups,
    async join(group) {
      if (isClosed || groups.includes(group)) return;
      await layer.groupAdd(group, requireChannel().name);
      groups.push(group);
    },
    async leave(group) {
      const index = groups.indexOf(group);
      if (index === -1) return;
      groups.splice(index, 1);
      await layer.groupDiscard(group, requireChannel().name);
    },
    close(code, reason) {
      if (isClosed) return;
      isClosed = true;
      transport.close(code, reason);
    },
  };

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

  const context = (envelope: Envelope): Context<string, unknown, unknown, Message> => ({
    conn,
    params: request.params,
    state,
    ref: envelope.ref,
    signal: abort.signal,
    send: async (message) => write(message, envelope),
    push: async (message) => write(message, { topic: envelope.topic }),
    async broadcast(message, { groups: targets = groups, excludeCurrent = false } = {}) {
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
    },
  });

  const ready = (async () => {
    if (consumer.authenticate && !(await authenticate())) {
      conn.close();
      return false;
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
    await consumer.onConnect?.(context({}) as never);
    return true;
  })().catch((error: unknown) => {
    logger.error('chanx: connecting failed', error);
    conn.close(1011);
    return false;
  });

  async function authenticate(): Promise<boolean> {
    const reply = (status_code: number, status_text: string, data: unknown) =>
      write(AuthenticationMessage.create({ status_code, status_text, data }), {});
    try {
      const user = await consumer.authenticate!(request);
      if (user === false || user === null || user === undefined) {
        reply(401, 'Unauthorized', {
          detail: 'Authentication credentials were not provided.',
        });
        return false;
      }
      (conn as { user: unknown }).user = user;
      reply(200, 'OK', { detail: 'OK' });
      return true;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        reply(error.status, error.statusText, error.data);
      } else {
        // As chanx: an unexpected failure is logged and the client told nothing.
        logger.error('chanx: authentication raised', error);
      }
      return false;
    }
  }

  async function handleFrame(data: string) {
    if (!(await ready) || isClosed) return;

    let content: unknown;
    try {
      content = JSON.parse(data);
    } catch {
      write(ErrorMessage.create({ detail: 'Invalid JSON' }), {});
      return;
    }
    const issues = envelopeIssues(content);
    if (issues.length) return void write(ErrorMessage.create(issues), {});

    // Checked above: topic and ref are strings, null or absent.
    const { version, topic, ref, seq, ...rest } = content as Record<string, unknown>;
    const envelope: Envelope = {
      ref: (ref as string | null) ?? undefined,
      topic: (topic as string | null) ?? undefined,
    };
    const message = (options.camelize ? decamelize(rest) : rest) as Record<
      string,
      unknown
    >;

    if (envelope.topic !== undefined) return handleTopicFrame(message, envelope);

    await handleMessage(message, envelope);
    if (options.sendCompletion) write(CompleteMessage.create(), envelope);
  }

  async function handleMessage(frame: Record<string, unknown>, envelope: Envelope) {
    if (definition.handlers.size === 0) {
      logger.error(`chanx: consumer "${consumer.name}" has no message handlers`);
      return write(
        ErrorMessage.create({ detail: 'Failed to process message' }),
        envelope,
      );
    }
    const result = await validate(frame);
    if ('issues' in result) return write(ErrorMessage.create(result.issues), envelope);

    const { message } = result;
    const handler = definition.handlers.get(message.action)!;
    try {
      const reply = await handler.handle(message, context(envelope));
      if (reply !== undefined) {
        checkDeclared(handler, reply);
        write(reply as object, envelope);
      }
    } catch (error) {
      logger.error(`chanx: handler for "${message.action}" failed`, error);
      write(
        ErrorMessage.create({
          detail: `Failed to process message for ${message.action}`,
        }),
        envelope,
      );
    }
  }

  // Topics are not mounted yet, so a topic frame gets chanx's answer for an unknown one.
  async function handleTopicFrame(frame: Record<string, unknown>, envelope: Envelope) {
    const topic = envelope.topic!;
    if (frame.action === 'unsubscribe')
      return write({ action: 'unsubscribed', payload: null }, envelope);
    const [reason, detail] =
      frame.action === 'subscribe'
        ? [TopicErrorReason.UNKNOWN_TOPIC, `Unknown topic '${topic}'`]
        : [TopicErrorReason.NOT_SUBSCRIBED, `Not subscribed to '${topic}'`];
    logger.warn('chanx: topic error', { topic, reason, detail });
    write(ErrorMessage.create({ reason, detail }), envelope);
  }

  // Layer messages wait for the connection to be ready, as chanx queues them behind connect.
  function onLayerMessage(message: ChannelMessage) {
    void (async () => {
      if (!(await ready) || isClosed) return;
      if (message.type === GROUP_MESSAGE) return handleGroupMessage(message);
      if (message.type === CHANNEL_EVENT) return handleEvent(message.event_data);
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

  async function handleEvent(data: unknown) {
    if (eventHandlers.size === 0) {
      return logger.error(`chanx: consumer "${consumer.name}" has no event handlers`);
    }
    if (!isObject(data)) return logger.error('chanx: channel event is not a dict', data);
    const result = await validateEvent(data);
    if ('issues' in result) {
      return logger.error('chanx: channel event failed validation', result.issues);
    }

    const { message } = result;
    const handler = eventHandlers.get(message.action)!;
    try {
      const reply = await handler.handle(message, context({}));
      if (reply !== undefined) {
        checkDeclared(handler, reply);
        write(reply as object, {});
      }
    } catch (error) {
      logger.error(`chanx: event handler for "${message.action}" failed`, error);
    }
    if (options.sendCompletion) write(EventCompleteMessage.create(), {});
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
      // The hook runs first, as chanx's teardown runs before the groups are left.
      teardown = (async () => {
        if (connected) await consumer.onDisconnect?.(context({}) as never);
        await channel?.close();
      })().catch((error: unknown) => logger.error('chanx: disconnecting failed', error));
      return teardown;
    },
  };
}
