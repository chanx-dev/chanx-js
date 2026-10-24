/**
 * A Fastify plugin serving chanx through `@fastify/websocket`.
 *
 * @module fastify
 */
import type { FastifyPluginAsync } from 'fastify';
import type {} from '@fastify/websocket';
import type { WebSocket } from 'ws';

import type { AcceptedUpgrade, Chanx } from '../app';
import { internals } from '../app';
import type { SocketOptions } from './ws-socket';
import { Heartbeat, serveWebSocket, toHeaders } from './ws-socket';

/** Options for `chanxFastify()`. */
export type FastifyChanxOptions = SocketOptions;

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
  { pingInterval = 20_000, maxBufferedAmount }: FastifyChanxOptions = {},
): FastifyPluginAsync {
  return async (fastify) => {
    if (!fastify.websocketServer) {
      throw new Error('Register @fastify/websocket before chanxFastify()');
    }
    // Only chanx's sockets: other websocket routes share the server's client list.
    const sockets = new Set<WebSocket>();
    const heartbeat = new Heartbeat(() => sockets, pingInterval);

    const upgrades = new WeakMap<object, AcceptedUpgrade>();

    for (const path of internals.get(chanx)!.paths) {
      fastify.get(
        path.replace(/\{(\w+)\}/g, ':$1'),
        {
          websocket: true,
          // After Fastify's own hooks, before the upgrade: a refusal is an HTTP response.
          preHandler: async (request, reply) => {
            const upgrade = await chanx.upgrade({
              url: request.url,
              headers: toHeaders(request.headers),
            });
            if (!upgrade) return reply.code(404).send();
            if (!upgrade.accepted) {
              return reply
                .code(upgrade.status)
                .header('content-type', 'application/json')
                .send(upgrade.body);
            }
            upgrades.set(request, upgrade);
          },
        },
        (ws, request) => {
          sockets.add(ws);
          ws.on('close', () => sockets.delete(ws));
          serveWebSocket(chanx, ws, upgrades.get(request)!, heartbeat, maxBufferedAmount);
        },
      );
    }

    // @fastify/websocket closes the sockets as Fastify closes; its preClose option says how.
    fastify.addHook('onClose', async () => heartbeat.stop());
  };
}

export type { SocketOptions } from './ws-socket';
