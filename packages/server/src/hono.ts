/**
 * Hono middleware, on any runtime.
 *
 * @module hono
 */
import type { MiddlewareHandler } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';

import type { Chanx } from './app';
import type { Session } from './session';

/**
 * Hono middleware serving chanx, on any runtime: pass the runtime's `upgradeWebSocket`
 * (from `hono/bun`, `hono/deno`, `hono/cloudflare-workers` or `@hono/node-ws`). Requests
 * for paths no consumer serves go on to the next handler.
 *
 * ```ts
 * app.get('/ws/*', chanxHono(chanx, upgradeWebSocket));
 * ```
 */
export function chanxHono(
  chanx: Chanx,
  upgradeWebSocket: UpgradeWebSocket,
): MiddlewareHandler {
  const upgrade = upgradeWebSocket((c) => {
    let session: Session | undefined;
    return {
      onOpen(_event, ws) {
        session = chanx.connect(
          { url: c.req.url, headers: c.req.raw.headers },
          {
            send: (data) => ws.send(data),
            close: (code = 1000, reason) => ws.close(code, reason),
          },
        );
        if (!session) ws.close(1008, 'No consumer serves this path');
      },
      onMessage(event) {
        session?.receive(event.data);
      },
      onClose() {
        void session?.closed();
      },
    };
  });
  return (c, next) => (chanx.match(c.req.path) ? upgrade(c, next) : next());
}
