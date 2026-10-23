import type { ChannelMessage } from '@chanx-js/layers';

import type { Chanx, ConsumerLike } from './app';
import { internals } from './app';
import type { EventsOf } from './consumer';
import { definitionOf } from './consumer';
import type { Message } from './messages';
import { TOPIC_EVENT, topicGroup } from './session';
import type { TopicLike } from './topic';
import { topicDefinitionOf } from './topic';

/** A frame as the test client receives it. */
export type Frame = Record<string, unknown> & {
  action?: string;
  ref?: string;
  topic?: string;
};

/** How long a test client waits for a frame. */
export interface WaitOptions {
  /** In milliseconds. Each method says its default. */
  timeout?: number;
}

/** A client connected in-process by `connect()`. */
export interface TestClient {
  /** Resolves once the server has connected this client: authenticated, groups joined. */
  readonly ready: Promise<boolean>;
  /** Frames received and not yet consumed by `receive()`. */
  readonly pending: readonly Frame[];
  /** Send a raw frame, as it goes on the wire. */
  send(frame: object): void;
  /** Send a message as `.create()` builds it, with a `ref` or `topic` when given. */
  sendMessage(message: Message, options?: { topic?: string; ref?: string }): void;
  /** The next frame from the server, within a second unless told otherwise. */
  receive(options?: WaitOptions): Promise<Frame>;
  /** Send a message with a fresh `ref` and resolve with the reply that echoes it. */
  request(message: object, options?: WaitOptions & { topic?: string }): Promise<Frame>;
  /** Collect frames until one with this action arrives, that one included. */
  receiveUntil(action?: string, options?: WaitOptions): Promise<Frame[]>;
  /** Every frame that arrives until none has for `timeout` ms (default 100). */
  receiveAll(options?: WaitOptions): Promise<Frame[]>;
  /** Whether no frame arrives within `timeout` ms (default 100). */
  receiveNothing(options?: WaitOptions): Promise<boolean>;
  /** Subscribe to a topic; resolves with the server's reply. */
  subscribe(topic: string, options?: WaitOptions): Promise<Frame>;
  /** Unsubscribe from a topic; resolves with the server's reply. */
  unsubscribe(topic: string, options?: WaitOptions): Promise<Frame>;
  /** Close from the client side; resolves once the server has torn the connection down. */
  close(): Promise<void>;
  /** Resolves when the server closes the socket. */
  readonly closed: Promise<{ code?: number; reason?: string }>;
}

/** Connect to a chanx app in-process, without a network. */
export function connect(
  app: Chanx,
  url: string,
  { headers }: { headers?: HeadersInit } = {},
): TestClient {
  const frames: Frame[] = [];
  const waiters: Array<(frame: Frame) => void> = [];
  let onClose!: (event: { code?: number; reason?: string }) => void;
  const closed = new Promise<{ code?: number; reason?: string }>(
    (resolve) => (onClose = resolve),
  );
  let refs = 0;

  const session = app.connect(
    { url, headers },
    {
      send(data) {
        const frame = JSON.parse(data) as Frame;
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else frames.push(frame);
      },
      close(code, reason) {
        onClose({ code, reason });
        void session?.closed();
      },
    },
  );
  if (!session) throw new Error(`No consumer serves ${url}`);

  const receive = ({ timeout = 1000 } = {}) => {
    const frame = frames.shift();
    if (frame) return Promise.resolve(frame);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`No frame within ${timeout}ms`));
      }, timeout);
      const waiter = (frame: Frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      waiters.push(waiter);
    });
  };

  const request = async (
    message: object,
    { topic, timeout }: WaitOptions & { topic?: string } = {},
  ) => {
    const ref = `test-${++refs}`;
    session.receive(
      JSON.stringify({ ...message, version: 1, ref, ...(topic && { topic }) }),
    );
    for (;;) {
      const frame = await receive({ timeout });
      if (frame.ref === ref) return frame;
    }
  };
  const nextWithin = (timeout: number) =>
    receive({ timeout }).then(
      (frame) => frame,
      () => undefined,
    );

  return {
    ready: session.ready,
    pending: frames,
    send: (frame) => session.receive(JSON.stringify(frame)),
    sendMessage(message, { topic, ref } = {}) {
      session.receive(
        JSON.stringify({
          ...message,
          ...(topic !== undefined && { version: 1, topic }),
          ...(ref !== undefined && { ref }),
        }),
      );
    },
    receive,
    request,
    async receiveUntil(action = 'complete', options) {
      const received: Frame[] = [];
      for (;;) {
        const frame = await receive(options);
        received.push(frame);
        if (frame.action === action) return received;
      }
    },
    async receiveAll({ timeout = 100 } = {}) {
      const received: Frame[] = [];
      for (
        let frame = await nextWithin(timeout);
        frame;
        frame = await nextWithin(timeout)
      ) {
        received.push(frame);
      }
      return received;
    },
    async receiveNothing({ timeout = 100 } = {}) {
      const frame = await nextWithin(timeout);
      if (frame) frames.unshift(frame);
      return frame === undefined;
    },
    subscribe: (topic, options) =>
      request({ action: 'subscribe' }, { ...options, topic }),
    unsubscribe: (topic, options) =>
      request({ action: 'unsubscribe' }, { ...options, topic }),
    close() {
      onClose({ code: 1000 });
      return session.closed();
    },
    closed,
  };
}

/** What a capture recorded, and how to stop it. */
export interface Capture<T> {
  readonly captured: readonly T[];
  /** Stop capturing and deliver as before. */
  restore(): void;
}

/** One `broadcastEvent()` call, as `captureBroadcastEvents` records it. */
export interface CapturedBroadcastEvent<E> {
  event: E;
  /** The groups passed, or `undefined` for the consumer's own. */
  groups: readonly string[] | undefined;
}

/** One publish to a topic, as `captureTopicBroadcasts` records it. */
export interface CapturedTopicBroadcast<E> {
  topic: string;
  event: E;
  seq: number | undefined;
}

/**
 * Record a consumer's `broadcastEvent()` calls, to assert on what was sent rather than
 * on what a second client received. Suppressed by default: recorded, not delivered.
 */
export function captureBroadcastEvents<C extends ConsumerLike>(
  app: Chanx,
  consumer: C,
  { suppress = true }: { suppress?: boolean } = {},
): Capture<CapturedBroadcastEvent<EventsOf<C>>> {
  const captured: CapturedBroadcastEvent<EventsOf<C>>[] = [];
  const target = definitionOf(consumer);
  const original = app.broadcastEvent;
  app.broadcastEvent = async (source, event, groups) => {
    if (definitionOf(source) === target) {
      captured.push({ event: event as unknown as EventsOf<C>, groups });
      if (suppress) return;
    }
    await original(source, event, groups);
  };
  return { captured, restore: () => void (app.broadcastEvent = original) };
}

/**
 * Record what is published to a topic, from `chanx.publish()` or a handler's
 * `ctx.publish()` alike. Suppressed by default: recorded, not delivered.
 */
export function captureTopicBroadcasts<T extends TopicLike>(
  app: Chanx,
  topic: T,
  { suppress = true }: { suppress?: boolean } = {},
): Capture<CapturedTopicBroadcast<EventsOf<T>>> {
  const captured: CapturedTopicBroadcast<EventsOf<T>>[] = [];
  const definition = topicDefinitionOf(topic);
  const layer = internals.get(app)!.layerOf(definition);
  const original = layer.groupSend;
  const ownsGroupSend = Object.hasOwn(layer, 'groupSend');
  const isThisTopic = (group: string, message: ChannelMessage) =>
    message.type === TOPIC_EVENT &&
    typeof message.topic === 'string' &&
    definition.match(message.topic) !== null &&
    topicGroup(definition, message.topic) === group;

  layer.groupSend = async (group, message) => {
    if (isThisTopic(group, message)) {
      captured.push({
        topic: message.topic as string,
        event: message.event_data as EventsOf<T>,
        seq: (message.seq as number | null) ?? undefined,
      });
      if (suppress) return;
    }
    await original.call(layer, group, message);
  };
  return {
    captured,
    restore() {
      if (ownsGroupSend) layer.groupSend = original;
      else delete (layer as Partial<typeof layer>).groupSend;
    },
  };
}
