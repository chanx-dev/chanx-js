import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

import { createClient, defineChannel } from '@chanx-js/client';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';

import type { Chanx } from '../src';
import { PingMessage, PongMessage, consumer, createChanx, defineMessage } from '../src';
import { chanxFastify } from '../src/adapters/fastify';
import { attachChanx } from '../src/adapters/node';
import type { OnCleanup } from './servers';
import { SERVERS, listen, startFastify } from './servers';

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
const onCleanup: OnCleanup = (cleanup) => void cleanups.push(cleanup);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  disconnected.mockClear();
});

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

describe.each(SERVERS)('the %s adapter', (name, startServer) => {
  const start = (chanx: Chanx) => startServer(chanx, onCleanup);
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

  it('closes with 4401 after a failed authentication', async () => {
    const client = open(`${await start(app())}/ws/chat/lobby`, {});
    expect(await client.closed).toBe(4401);
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

  it('refuses an upgrade with an HTTP status first, given rejectBeforeUpgrade', async () => {
    const guarded = consumer('/ws/guarded', {
      name: 'guarded',
      authenticate: ({ headers }) =>
        headers.get('authorization') === 'Bearer ok' ? { id: 1 } : false,
      rejectBeforeUpgrade: true,
    });
    const url = await start(createChanx({ consumers: [guarded] }));

    const refused = new WebSocket(`${url}/ws/guarded`);
    // Closing a handshake the server refused reports it as an error: expected here.
    refused.on('error', () => {});
    cleanups.push(() => refused.terminate());
    const response = await new Promise<{ status?: number; body: string }>((resolve) =>
      refused.on('unexpected-response', (_request, res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }),
    );
    expect(response).toEqual({
      status: 401,
      // @hono/node-server answers a refused upgrade with its status alone.
      body:
        name === 'hono'
          ? ''
          : JSON.stringify({ detail: 'Authentication credentials were not provided.' }),
    });

    const client = open(`${url}/ws/guarded`);
    await client.next(1);
    expect(client.frames[0]).toMatchObject({
      action: 'authentication',
      payload: { status_code: 200 },
    });
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
    const url = await SERVERS[2]![1](createChanx({ consumers: [chat] }), onCleanup);
    const response = await fetch(`${url.replace('ws:', 'http:')}/plain`);
    expect(await response.text()).toBe('plain http still works');
  });
});

describe('the fastify adapter', () => {
  const app = () => createChanx({ consumers: [chat] });

  it("runs Fastify's hooks before the upgrade, so one can refuse it with a status", async () => {
    const url = await startFastify(app(), onCleanup, {
      setup: (fastify) =>
        fastify.addHook('onRequest', async (request, reply) => {
          if (request.headers['x-api-key'] !== 'secret') await reply.code(401).send();
        }),
    });

    const refused = new WebSocket(`${url}/ws/chat/lobby`);
    const status = await new Promise<number>((resolve) =>
      refused.on('unexpected-response', (_request, response) =>
        resolve(response.statusCode!),
      ),
    );
    expect(status).toBe(401);

    const client = open(`${url}/ws/chat/lobby`, {
      authorization: 'Bearer ok',
      'x-api-key': 'secret',
    });
    await client.next(1);
    expect(client.frames[0]).toMatchObject({ action: 'authentication' });
  });

  it('leaves other routes, websocket ones included, to the app', async () => {
    const url = await startFastify(app(), onCleanup, {
      setup: (fastify) => {
        fastify.get('/plain', () => 'plain');
        fastify.get('/echo', { websocket: true }, (ws) => ws.send('"echo"'));
      },
    });

    expect(await (await fetch(`${url.replace('ws://', 'http://')}/plain`)).text()).toBe(
      'plain',
    );
    const echo = open(`${url}/echo`);
    await echo.next(1);
    expect(echo.frames).toEqual(['echo']);
  });

  it('closes its sockets when Fastify closes', async () => {
    const fastify = Fastify();
    await fastify.register(websocket);
    await fastify.register(chanxFastify(app()));
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    const port = (fastify.server.address() as AddressInfo).port;
    const client = open(`ws://127.0.0.1:${port}/ws/chat/lobby`);
    await client.next(1);

    await fastify.close();

    expect(await client.closed).toBe(1005);
  });

  it("drops chanx clients that stop answering pings, leaving other routes' clients", async () => {
    const url = await startFastify(app(), onCleanup, {
      setup: (fastify) => fastify.get('/echo', { websocket: true }, () => {}),
      pingInterval: 30,
    });
    const silentChanx = new WebSocket(`${url}/ws/chat/lobby`, {
      headers: { authorization: 'Bearer ok' },
      autoPong: false,
    });
    const silentOther = new WebSocket(`${url}/echo`, { autoPong: false });
    cleanups.push(
      () => silentChanx.terminate(),
      () => silentOther.terminate(),
    );
    await new Promise((resolve) => silentOther.once('open', resolve));

    const code = await new Promise<number>((resolve) => silentChanx.on('close', resolve));
    expect(code).toBe(1006);
    expect(silentOther.readyState).toBe(WebSocket.OPEN);
  });

  it('says what to register first without @fastify/websocket', async () => {
    const fastify = Fastify();
    cleanups.push(() => fastify.close());
    await expect(fastify.register(chanxFastify(app()))).rejects.toThrow(
      'Register @fastify/websocket before chanxFastify()',
    );
  });
});

describe.each([
  [
    'node (ws)',
    async (chanx: Chanx, maxBufferedAmount: number) => {
      const server = createServer();
      const attachment = attachChanx(server, chanx, { maxBufferedAmount });
      onCleanup(() => attachment.close());
      return listen(server, onCleanup);
    },
  ],
  [
    'fastify',
    (chanx: Chanx, maxBufferedAmount: number) =>
      startFastify(chanx, onCleanup, { maxBufferedAmount }),
  ],
] as const)('backpressure on the %s adapter', (_name, start) => {
  const Flood = defineMessage('flood');
  const Chunk = defineMessage('chunk', z.object({ data: z.string() }));
  const COUNT = 64;
  const flooder = consumer('/ws/flood', { name: 'flood', emits: [Chunk] }).on(
    Flood,
    async (_m, ctx) => {
      const data = 'x'.repeat(256 * 1024);
      // A stream, not one burst: a reading client drains each chunk before the next.
      for (let i = 0; i < COUNT; i++) {
        await ctx.push(Chunk.create({ data }));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  );

  it('drops a client that stops reading, and serves one that keeps up', async () => {
    const logger = { error() {}, warn: vi.fn() };
    const url = await start(createChanx({ consumers: [flooder], logger }), 1024 * 1024);

    const stalled = new WebSocket(`${url}/ws/flood`);
    const reading = new WebSocket(`${url}/ws/flood`);
    cleanups.push(
      () => stalled.terminate(),
      () => reading.terminate(),
    );
    let received = 0;
    reading.on('message', () => received++);
    await Promise.all(
      [stalled, reading].map((ws) => new Promise((resolve) => ws.once('open', resolve))),
    );
    const stalledClosed = new Promise<number>((resolve) => stalled.on('close', resolve));
    stalled.pause();

    stalled.send(JSON.stringify({ action: 'flood' }));
    reading.send(JSON.stringify({ action: 'flood' }));

    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/more than maxBufferedAmount/),
      ),
    );
    // Paused, the client reads nothing, not even its socket closing: resume to see it.
    stalled.resume();
    expect(await stalledClosed).toBe(1006);
    await vi.waitFor(() => expect(received).toBe(COUNT), { timeout: 5000 });
  });
});
