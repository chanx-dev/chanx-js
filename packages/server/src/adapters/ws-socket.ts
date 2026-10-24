import type { IncomingHttpHeaders } from 'node:http';

import type { WebSocket } from 'ws';

import type { AcceptedUpgrade, Chanx, RefusedUpgrade } from '../app';
import { internals } from '../app';

/** How a `ws` adapter keeps its sockets healthy. */
export interface SocketOptions {
  /**
   * Ping each client this often, closing one that has not answered the previous ping.
   * `0` turns it off. Defaults to 20 seconds.
   */
  pingInterval?: number;
  /**
   * Bytes that may wait unsent for one client before it is dropped: a client that stops
   * reading must not hold the server's memory. Defaults to 16 MiB.
   */
  maxBufferedAmount?: number;
}

export const DEFAULT_MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024;

/** Pings for one `ws` server's sockets: who answered since the last round. */
export class Heartbeat {
  private readonly alive = new WeakSet<WebSocket>();
  private readonly timer?: ReturnType<typeof setInterval>;

  constructor(clients: () => Iterable<WebSocket>, interval: number) {
    if (interval <= 0) return;
    this.timer = setInterval(() => {
      for (const ws of clients()) {
        if (!this.alive.has(ws)) {
          ws.terminate();
          continue;
        }
        this.alive.delete(ws);
        ws.ping();
      }
    }, interval);
    this.timer.unref();
  }

  watch(ws: WebSocket): void {
    this.alive.add(ws);
    ws.on('pong', () => this.alive.add(ws));
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

/** Serve one accepted `ws` socket; closes it when no consumer serves the URL. */
export function serveWebSocket(
  chanx: Chanx,
  ws: WebSocket,
  upgrade: AcceptedUpgrade,
  heartbeat: Heartbeat,
  maxBufferedAmount = DEFAULT_MAX_BUFFERED_AMOUNT,
): void {
  const send = (data: string) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(data);
    if (ws.bufferedAmount <= maxBufferedAmount) return;
    // A close frame would queue behind what the client is not reading: drop it.
    internals
      .get(chanx)
      ?.logger.warn(
        `chanx: dropped a client with ${ws.bufferedAmount} bytes unsent, more than maxBufferedAmount (${maxBufferedAmount})`,
      );
    ws.terminate();
  };
  const session = chanx.connect(upgrade, {
    send,
    close: (code = 1000, reason) => ws.close(code, reason),
  });
  if (!session) return ws.close(1008, 'No consumer serves this path');
  heartbeat.watch(ws);
  // A Buffer whether the frame was text or binary: ws's default binaryType.
  ws.on('message', (data, isBinary) =>
    session.receive(isBinary ? (data as Buffer) : data.toString()),
  );
  ws.on('close', () => void session.closed());
}

export function toHeaders(headers: IncomingHttpHeaders): [string, string][] {
  return Object.entries(headers).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
  );
}

/** A refused upgrade as raw HTTP, for a socket that was never upgraded. */
export function refusalResponse(refused: RefusedUpgrade): string {
  return (
    `HTTP/1.1 ${refused.status} ${refused.statusText}\r\n` +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(refused.body)}\r\n` +
    'Connection: close\r\n\r\n' +
    refused.body
  );
}
