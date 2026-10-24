/**
 * A Fastify plugin serving chanx through `@fastify/websocket`.
 *
 * @module fastify
 */
import type { FastifyPluginAsync } from 'fastify';
import type {} from '@fastify/websocket';
import type { WebSocket } from 'ws';

import type { Chanx } from './app';
import { internals } from './app';
import { Heartbeat, serveWebSocket } from './ws-socket';

/** Options for `chanxFastify()`. */
export interface FastifyChanxOptions {
  /**
   * Ping each client this often, closing one that has not answered the previous ping.
   * `0` turns it off. Defaults to 20 seconds.
   */
  pingInterval?: number;
}

/**
 * Serve chanx as Fastify routes, one per consumer path, after registering
 * `@fastify/websocket`. Fastify's hooks run before each upgrade, so `onRequest` or an
 * auth plugin can refuse one with an HTTP status. Register it without a prefix: the
 * routes are the consumers' own paths.
 *
 * ```ts
 * await app.register(websocket);
 * await app.register(chanxFastify(chanx));
 * ```
 */
export function chanxFastify(
  chanx: Chanx,
  { pingInterval = 20_000 }: FastifyChanxOptions = {},
): FastifyPluginAsync {
  return async (fastify) => {
    if (!fastify.websocketServer) {
      throw new Error('Register @fastify/websocket before chanxFastify()');
    }
    // Only chanx's sockets: other websocket routes share the server's client list.
    const sockets = new Set<WebSocket>();
    const heartbeat = new Heartbeat(() => sockets, pingInterval);

    for (const path of internals.get(chanx)!.paths) {
      fastify.get(
        path.replace(/\{(\w+)\}/g, ':$1'),
        { websocket: true },
        (ws, request) => {
          sockets.add(ws);
          ws.on('close', () => sockets.delete(ws));
          serveWebSocket(chanx, ws, request.raw, heartbeat);
        },
      );
    }

    // @fastify/websocket closes the sockets as Fastify closes; its preClose option says how.
    fastify.addHook('onClose', async () => heartbeat.stop());
  };
}
