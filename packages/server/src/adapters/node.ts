/**
 * Serve an app on a Node HTTP server, through `ws`.
 *
 * @module node
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';

import type { Chanx } from '../app';
import type { AsyncAPIServeOptions } from '../asyncapi-http';
import { asyncapiHandler } from '../asyncapi-http';
import type { SocketOptions } from './ws-socket';
import { Heartbeat, refusalResponse, serveWebSocket, toHeaders } from './ws-socket';

type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** Options for `attachChanx()`. */
export type AttachOptions = SocketOptions;

/** A running `attachChanx()`. */
export interface Attachment {
  /** Stop serving: detach from the server and close every socket with 1001 (going away). */
  close(): Promise<void>;
}

/**
 * Serve chanx on a Node HTTP server: plain `http`, or the one Express, Fastify, Koa or
 * NestJS (`app.getHttpServer()`) runs on. Upgrades for other paths go to the server's
 * other WebSocket servers; those attached before chanx never see chanx's paths.
 */
export function attachChanx(
  server: Server,
  chanx: Chanx,
  { pingInterval = 20_000, maxBufferedAmount }: AttachOptions = {},
): Attachment {
  const wss = new WebSocketServer({ noServer: true });
  const heartbeat = new Heartbeat(() => wss.clients, pingInterval);

  // Listeners already on the server only see the paths chanx leaves alone: some, Nest's
  // WsAdapter among them, destroy every upgrade for a path they do not serve.
  const others = server.listeners('upgrade') as UpgradeListener[];
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'ws://localhost').pathname;
    if (chanx.match(path)) {
      chanx
        .upgrade({ url: request.url ?? '/', headers: toHeaders(request.headers) })
        .then((upgrade) => {
          if (!upgrade?.accepted) {
            if (upgrade) socket.end(refusalResponse(upgrade));
            else socket.destroy();
            return;
          }
          wss.handleUpgrade(request, socket, head, (ws) =>
            serveWebSocket(chanx, ws, upgrade, heartbeat, maxBufferedAmount),
          );
        })
        .catch((error: unknown) => socket.destroy(error as Error));
      return;
    }
    for (const listener of others) listener.call(server, request, socket, head);
    // With no other listener at all, nothing would ever answer.
    if (!others.length && server.listenerCount('upgrade') === 1) socket.destroy();
  };

  for (const listener of others) server.off('upgrade', listener);
  server.on('upgrade', onUpgrade);

  return {
    async close() {
      server.off('upgrade', onUpgrade);
      for (const listener of others) server.on('upgrade', listener);
      heartbeat.stop();
      for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/**
 * Serve the AsyncAPI document on a Node HTTP server, as `asyncapiHandler()` does: Express
 * or Connect middleware, mounted at the root. Other requests go to `next`.
 *
 * ```ts
 * expressApp.use(asyncapiMiddleware(chanx, { title: 'Chat API' }));
 * ```
 */
export function asyncapiMiddleware(
  chanx: Chanx,
  options?: AsyncAPIServeOptions,
): (
  request: IncomingMessage,
  response: ServerResponse,
  next?: (error?: unknown) => void,
) => void {
  const handle = asyncapiHandler(chanx, options);
  return (request, response, next) => {
    const scheme = (request.socket as TLSSocket).encrypted ? 'https' : 'http';
    const url = `${scheme}://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`;
    handle(
      new Request(url, { method: request.method, headers: toHeaders(request.headers) }),
    )
      .then(async (answer) => {
        if (!answer) {
          if (next) next();
          else response.writeHead(404).end();
          return;
        }
        response.writeHead(answer.status, Object.fromEntries(answer.headers));
        response.end(
          request.method === 'HEAD' ? undefined : Buffer.from(await answer.arrayBuffer()),
        );
      })
      .catch((error: unknown) => (next ? next(error) : response.destroy(error as Error)));
  };
}

export type { SocketOptions } from './ws-socket';
