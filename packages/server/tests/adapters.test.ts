import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

import { createClient, defineChannel } from '@chanx-js/client';
import { serve, upgradeWebSocket } from '@hono/node-server';
import nodeAdapter from 'crossws/adapters/node';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

import type { Chanx } from '../src';
import { PingMessage, PongMessage, consumer, createChanx, defineMessage } from '../src';
import { chanxHooks } from '../src/crossws';
import { chanxHono } from '../src/hono';
import { attachChanx } from '../src/node';

const Chat = defineMessage('chat', z.object({ text: z.string() }));
const Notice = defineMessage('notice', z.object({ text: z.string() }));
const disconnected = vi.fn();

const chat = consumer('/ws/chat/{room}', {
  name: 'chat',
  emits: [Notice],
  authenticate: ({ headers }) =>
    headers.get('authorization') === 'Bearer ok' ? { id: 1 } : false,
  onDisconnect: () => disconnected(),
})
  .on(PingMessage, { output: PongMessage }, () => PongMessage.create())
  .on(Chat, async (m, ctx) => {
    await ctx.send(Notice.create({ text: `${ctx.params.room}: ${m.payload.text}` }));
  });

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  disconnected.mockClear();
});

const listen = async (server: ReturnType<typeof createServer>) => {
  if (!server.listening)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

// Each serves the same app, the way an application would wire that adapter.
const ADAPTERS: Array<[string, (chanx: Chanx) => Promise<string>]> = [
  [
    'node (ws)',
    async (chanx) => {
      const server = createServer();
      const attachment = attachChanx(server, chanx);
      cleanups.push(() => attachment.close());
      return listen(server);
    },
  ],
  [
    'crossws',
    async (chanx) => {
      const ws = nodeAdapter({ hooks: chanxHooks(chanx) });
      const server = createServer();
      server.on('upgrade', (request, socket, head) =>
        ws.handleUpgrade(request, socket, head),
      );
      cleanups.push(() => ws.closeAll());
      return listen(server);
    },
  ],
  [
    'hono',
    async (chanx) => {
      const app = new Hono();
      app.get('/ws/*', chanxHono(chanx, upgradeWebSocket));
      app.get('/plain', (c) => c.text('plain http still works'));
      const wss = new WebSocketServer({ noServer: true });
      const server = await new Promise<ReturnType<typeof createServer>>((resolve) => {
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
      cleanups.push(() => new Promise((resolve) => wss.close(resolve)));
      return listen(server);
    },
  ],
];

function open(
  url: string,
  headers: Record<string, string> = { authorization: 'Bearer ok' },
) {
  const ws = new WebSocket(url, { headers });
  const frames: unknown[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  const opened = new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const closed = new Promise<number>((resolve) =>
    ws.on('close', (code) => resolve(code)),
  );
  cleanups.push(() => ws.terminate());
  return {
    ws,
    frames,
    opened,
    closed,
    next: (count: number) => vi.waitFor(() => expect(frames).toHaveLength(count)),
  };
}

describe.each(ADAPTERS)('the %s adapter', (_name, start) => {
  const app = () => createChanx({ consumers: [chat], logger: { error() {}, warn() {} } });

  it('serves a consumer: authentication, path params, ref echo', async () => {
    const client = open(`${await start(app())}/ws/chat/lobby`);
    await client.opened;
    client.ws.send(
      JSON.stringify({ action: 'chat', payload: { text: 'hi' }, version: 1, ref: 'a' }),
    );

    await client.next(2);
    expect(client.frames).toEqual([
      {
        action: 'authentication',
        payload: { status_code: 200, status_text: 'OK', data: { detail: 'OK' } },
      },
      { action: 'notice', payload: { text: 'lobby: hi' }, version: 1, ref: 'a' },
    ]);
  });

  it('closes after a failed authentication', async () => {
    const client = open(`${await start(app())}/ws/chat/lobby`, {});
    expect(await client.closed).toBe(1000);
    expect(client.frames).toMatchObject([
      { action: 'authentication', payload: { status_code: 401 } },
    ]);
  });

  it('runs onDisconnect when the client leaves', async () => {
    const client = open(`${await start(app())}/ws/chat/lobby`);
    await client.next(1);
    client.ws.close();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce());
  });

  it('refuses a path no consumer serves', async () => {
    await expect(open(`${await start(app())}/ws/elsewhere`).opened).rejects.toThrow();
  });

  it('refuses a binary frame, as chanx does, keeping the connection', async () => {
    const client = open(`${await start(app())}/ws/chat/lobby`);
    await client.opened;
    client.ws.send(Buffer.from(JSON.stringify({ action: 'ping' })), { binary: true });
    client.ws.send(JSON.stringify({ action: 'ping' }));
    await client.next(3);
    expect(client.frames.slice(1)).toEqual([
      {
        action: 'error',
        payload: [
          {
            type: 'json_invalid',
            loc: [],
            msg: 'Invalid JSON: binary frames are not supported',
          },
        ],
      },
      { action: 'pong', payload: null },
    ]);
  });

  it('works with @chanx-js/client', async () => {
    type ToServer = { action: 'ping'; payload: null };
    type ToClient = { action: 'pong'; payload: null };
    const descriptor = defineChannel<ToServer, ToClient>()({
      name: 'chat',
      address: '/ws/chat/{room}',
    });
    const client = createClient({
      baseUrl: await start(app()),
      socketFactory: (address) =>
        new WebSocket(address, { headers: { authorization: 'Bearer ok' } }) as never,
    });
    cleanups.push(() => client.closeAll());

    const connection = client.connect(descriptor, { params: { room: 'lobby' } });
    expect(await connection.request({ action: 'ping', payload: null })).toEqual({
      action: 'pong',
      payload: null,
    });
  });
});

describe('the hono adapter', () => {
  it('leaves other routes to the app', async () => {
    const url = await ADAPTERS[2]![1](createChanx({ consumers: [chat] }));
    const response = await fetch(`${url.replace('ws:', 'http:')}/plain`);
    expect(await response.text()).toBe('plain http still works');
  });
});
