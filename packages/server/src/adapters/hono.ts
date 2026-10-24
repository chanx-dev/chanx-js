/**
 * Hono middleware, on any runtime.
 *
 * @module hono
 */
import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { UpgradeWebSocket } from 'hono/ws';

import type { AcceptedUpgrade, Chanx } from '../app';
import type { Session } from '../session';

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
  const upgrades = new WeakMap<object, AcceptedUpgrade>();
  const upgrade = upgradeWebSocket((c) => {
    let session: Session | undefined;
    return {
      onOpen(_event, ws) {
        session = chanx.connect(upgrades.get(c)!, {
          send: (data) => ws.send(data),
          close: (code = 1000, reason) => ws.close(code, reason),
        });
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
  return async (c, next) => {
    if (!chanx.match(c.req.path)) return next();
    const accepted = await chanx.upgrade({ url: c.req.url, headers: c.req.raw.headers });
    if (!accepted) return next();
    if (!accepted.accepted) {
      return c.body(accepted.body, accepted.status as ContentfulStatusCode, {
        'content-type': 'application/json',
      });
    }
    upgrades.set(c, accepted);
    return upgrade(c, next);
  };
}
