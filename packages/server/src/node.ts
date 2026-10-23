import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import type { Chanx } from './app';

export interface AttachOptions {
  /**
   * Ping each client this often, closing one that has not answered the previous ping, as
   * uvicorn does for Python's chanx. `0` turns it off. Defaults to 20 seconds.
   */
  pingInterval?: number;
}

export interface Attachment {
  /** Stop serving: detach from the server and close every socket with 1001 (going away). */
  close(): Promise<void>;
}

/**
 * Serve chanx on a Node HTTP server: plain `http`, or the one Express, Fastify, Koa or
 * NestJS (`app.getHttpServer()`) runs on. Upgrades for other paths are left alone, so
 * other WebSocket servers can share it.
 */
export function attachChanx(
  server: Server,
  chanx: Chanx,
  { pingInterval = 20_000 }: AttachOptions = {},
): Attachment {
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakSet<WebSocket>();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'ws://localhost').pathname;
    if (!chanx.match(path)) {
      // Another listener may serve it; with none, nothing would ever answer.
      if (server.listenerCount('upgrade') === 1) socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => serve(ws, request));
  };

  const serve = (ws: WebSocket, request: IncomingMessage) => {
    const session = chanx.connect(
      { url: request.url ?? '/', headers: toHeaders(request.headers) },
      {
        send: (data) => ws.send(data),
        close: (code = 1000, reason) => ws.close(code, reason),
      },
    );
    if (!session) return ws.close(1008, 'No consumer serves this path');
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    // A Buffer whether the frame was text or binary: ws's default binaryType.
    ws.on('message', (data) => session.receive(data.toString()));
    ws.on('close', () => void session.closed());
  };

  const heartbeat =
    pingInterval > 0
      ? setInterval(() => {
          for (const ws of wss.clients) {
            if (!alive.has(ws)) {
              ws.terminate();
              continue;
            }
            alive.delete(ws);
            ws.ping();
          }
        }, pingInterval)
      : undefined;
  heartbeat?.unref();

  server.on('upgrade', onUpgrade);

  return {
    async close() {
      server.off('upgrade', onUpgrade);
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function toHeaders(headers: IncomingHttpHeaders): [string, string][] {
  return Object.entries(headers).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
  );
}
