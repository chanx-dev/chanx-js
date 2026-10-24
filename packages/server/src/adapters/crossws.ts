/**
 * crossws hooks: Bun, Deno, Cloudflare Workers, h3, Nitro and Nuxt.
 *
 * @module crossws
 */
import type { Hooks, Peer } from 'crossws';

import type { Chanx } from '../app';
import type { Session } from '../session';

/**
 * crossws hooks serving chanx: one adapter for Bun, Deno, Cloudflare Workers and Node,
 * and for frameworks built on crossws (h3, Nitro, Nuxt). Upgrades for paths no consumer
 * serves are refused with 404.
 */
export function chanxHooks(chanx: Chanx): Partial<Hooks> {
  const sessions = new WeakMap<Peer, Session>();
  return {
    upgrade(request) {
      if (!chanx.match(new URL(request.url).pathname)) {
        throw new Response('No consumer serves this path', { status: 404 });
      }
    },
    open(peer) {
      const session = chanx.connect(
        { url: peer.request.url, headers: peer.request.headers },
        {
          send: (data) => void peer.send(data),
          close: (code = 1000, reason) => peer.close(code, reason),
        },
      );
      if (!session) return peer.close(1008, 'No consumer serves this path');
      sessions.set(peer, session);
    },
    message(peer, message) {
      // Text frames arrive as strings. uWebSockets is the exception: crossws drops its
      // binary flag, so every frame there looks binary and is refused.
      const { rawData } = message;
      sessions
        .get(peer)
        ?.receive(typeof rawData === 'string' ? rawData : message.uint8Array());
    },
    close(peer) {
      void sessions.get(peer)?.closed();
      sessions.delete(peer);
    },
  };
}
