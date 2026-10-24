import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import websocket from '@fastify/websocket';
import { serve, upgradeWebSocket } from '@hono/node-server';
import nodeAdapter from 'crossws/adapters/node';
import { serve as serveCrossws } from 'crossws/server/node';
import express from 'express';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { H3, defineWebSocketHandler } from 'h3';
import { Hono } from 'hono';
import Koa from 'koa';
import { WebSocketServer } from 'ws';

import type { Chanx } from '../src';
import { chanxHooks } from '../src/adapters/crossws';
import type { FastifyChanxOptions } from '../src/adapters/fastify';
import { chanxFastify } from '../src/adapters/fastify';
import { chanxHono } from '../src/adapters/hono';
import { attachChanx } from '../src/adapters/node';

/** Registers what a test must undo, last first. */
export type OnCleanup = (cleanup: () => unknown) => void;

/** Serve an app over a real socket; resolves with its `ws://` base URL. */
export type StartServer = (chanx: Chanx, onCleanup: OnCleanup) => Promise<string>;

export async function listen(server: Server, onCleanup: OnCleanup): Promise<string> {
  if (!server.listening)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(() => new Promise((resolve) => server.close(resolve)));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function startFastify(
  chanx: Chanx,
  onCleanup: OnCleanup,
  {
    setup,
    ...options
  }: FastifyChanxOptions & { setup?: (app: FastifyInstance) => void } = {},
): Promise<string> {
  const app = Fastify();
  await app.register(websocket);
  setup?.(app);
  await app.register(chanxFastify(chanx, options));
  await app.listen({ port: 0, host: '127.0.0.1' });
  onCleanup(() => app.close());
  return `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

/** Every adapter, wired as an application would wire it. */
export const SERVERS: Array<[name: string, start: StartServer]> = [
  [
    'node (ws)',
    async (chanx, onCleanup) => {
      const server = createServer();
      const attachment = attachChanx(server, chanx);
      onCleanup(() => attachment.close());
      return listen(server, onCleanup);
    },
  ],
  [
    'crossws',
    async (chanx, onCleanup) => {
      const ws = nodeAdapter({ hooks: chanxHooks(chanx) });
      const server = createServer();
      server.on('upgrade', (request, socket, head) =>
        ws.handleUpgrade(request, socket, head),
      );
      onCleanup(() => ws.closeAll());
      return listen(server, onCleanup);
    },
  ],
  [
    'hono',
    async (chanx, onCleanup) => {
      const app = new Hono();
      app.get('/ws/*', chanxHono(chanx, upgradeWebSocket));
      app.get('/plain', (c) => c.text('plain http still works'));
      const wss = new WebSocketServer({ noServer: true });
      const server = await new Promise<Server>((resolve) => {
        const created = serve(
          {
            fetch: app.fetch,
            port: 0,
            hostname: '127.0.0.1',
            websocket: { server: wss },
          },
          () => resolve(created as never),
        );
      });
      onCleanup(() => new Promise((resolve) => wss.close(resolve)));
      return listen(server, onCleanup);
    },
  ],
  ['fastify', (chanx, onCleanup) => startFastify(chanx, onCleanup)],
  [
    'node (ws) under Express',
    async (chanx, onCleanup) => {
      const app = express();
      app.get('/plain', (_request, response) => void response.send('plain'));
      const server = createServer(app);
      const attachment = attachChanx(server, chanx);
      onCleanup(() => attachment.close());
      return listen(server, onCleanup);
    },
  ],
  [
    'node (ws) under Koa',
    async (chanx, onCleanup) => {
      const app = new Koa();
      app.use((ctx) => void (ctx.body = 'plain'));
      const server = createServer(app.callback());
      const attachment = attachChanx(server, chanx);
      onCleanup(() => attachment.close());
      return listen(server, onCleanup);
    },
  ],
  [
    'crossws under h3',
    async (chanx, onCleanup) => {
      const app = new H3();
      app.get('/ws/**', defineWebSocketHandler(chanxHooks(chanx)));
      const server = serveCrossws({
        fetch: app.fetch,
        port: 0,
        hostname: '127.0.0.1',
        silent: true,
        // Takes the hooks h3's defineWebSocketHandler() attaches to its response.
        websocket: {},
      });
      await server.ready();
      onCleanup(() => server.close(true));
      return `ws://127.0.0.1:${new URL(server.url!).port}`;
    },
  ],
];
