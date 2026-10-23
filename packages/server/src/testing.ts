import type { Chanx } from './app';

export type Frame = Record<string, unknown> & {
  action?: string;
  ref?: string;
  topic?: string;
};

export interface TestClient {
  /** Resolves once the server has connected this client: authenticated, groups joined. */
  readonly ready: Promise<boolean>;
  /** Frames received and not yet consumed by `receive()`. */
  readonly pending: readonly Frame[];
  /** Send a raw frame. */
  send(frame: object): void;
  /** The next frame from the server. */
  receive(options?: { timeout?: number }): Promise<Frame>;
  /** Send a message with a fresh `ref` and resolve with the reply that echoes it. */
  request(
    message: object,
    options?: { topic?: string; timeout?: number },
  ): Promise<Frame>;
  /** Collect frames until one with this action arrives (included), as chanx's `receive_all_messages`. */
  receiveUntil(action?: string, options?: { timeout?: number }): Promise<Frame[]>;
  /** Close from the client side; resolves once the server has torn the connection down. */
  close(): Promise<void>;
  /** Resolves when the server closes the socket. */
  readonly closed: Promise<{ code?: number; reason?: string }>;
}

/**
 * Connect to a chanx app in-process, without a network: what Python's
 * `WebsocketCommunicator` does for chanx consumers.
 */
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

  return {
    ready: session.ready,
    pending: frames,
    send: (frame) => session.receive(JSON.stringify(frame)),
    receive,
    async request(message, { topic, timeout } = {}) {
      const ref = `test-${++refs}`;
      session.receive(
        JSON.stringify({ ...message, version: 1, ref, ...(topic && { topic }) }),
      );
      for (;;) {
        const frame = await receive({ timeout });
        if (frame.ref === ref) return frame;
      }
    },
    async receiveUntil(action = 'complete', options) {
      const received: Frame[] = [];
      for (;;) {
        const frame = await receive(options);
        received.push(frame);
        if (frame.action === action) return received;
      }
    },
    close() {
      onClose({ code: 1000 });
      return session.closed();
    },
    closed,
  };
}
