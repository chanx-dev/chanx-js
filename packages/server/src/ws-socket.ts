import type { IncomingHttpHeaders } from 'node:http';

import type { WebSocket } from 'ws';

import type { Chanx } from './app';

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
  request: { url?: string; headers: IncomingHttpHeaders },
  heartbeat: Heartbeat,
): void {
  const session = chanx.connect(
    { url: request.url ?? '/', headers: toHeaders(request.headers) },
    {
      send: (data) => ws.send(data),
      close: (code = 1000, reason) => ws.close(code, reason),
    },
  );
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
