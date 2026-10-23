import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

import { ChanxRequestError, createClient, defineChannel } from '@chanx-js/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

import type { Chanx } from '../src';
import { PingMessage, PongMessage, consumer, createChanx, defineMessage } from '../src';
import type { Attachment } from '../src/node';
import { attachChanx } from '../src/node';

const Chat = defineMessage('chat', z.object({ text: z.string() }));
const Notice = defineMessage('notice', z.object({ text: z.string() }));

const disconnected = vi.fn();
const chat = consumer('/ws/chat/{room}', {
  name: 'chat',
  emits: [Notice],
  authenticate: ({ headers, url }) =>
    headers.get('authorization') === 'Bearer ok' || url.searchParams.get('token') === 'ok'
      ? { id: 1 }
      : false,
  onDisconnect: () => disconnected(),
})
  .on(PingMessage, { output: PongMessage }, () => PongMessage.create())
  .on(Chat, async (m, ctx) => {
    await ctx.send(Notice.create({ text: `${ctx.params.room}: ${m.payload.text}` }));
  });
const broken = consumer('/ws/broken', {
  name: 'broken',
  state: () => {
    throw new Error('no database');
  },
});

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  disconnected.mockClear();
});

async function serve(
  chanx: Chanx = createChanx({
    consumers: [chat, broken],
    logger: { error() {}, warn() {} },
  }),
  pingInterval?: number,
) {
  const server = createServer();
  const attachment: Attachment = attachChanx(server, chanx, { pingInterval });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () => new Promise((resolve) => server.close(resolve)),
    () => attachment.close(),
  );
  return {
    server,
    attachment,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

function open(url: string, options?: ConstructorParameters<typeof WebSocket>[2]) {
  const ws = new WebSocket(url, options);
  const frames: unknown[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  const opened = new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  cleanups.push(() => ws.terminate());
  return {
    ws,
    frames,
    closed,
    opened,
    next: (count: number) => vi.waitFor(() => expect(frames).toHaveLength(count)),
  };
}

const auth = { headers: { authorization: 'Bearer ok' } };

describe('attachChanx', () => {
  it('serves a consumer over a real socket, with path params and headers', async () => {
    const { url } = await serve();
    const client = open(`${url}/ws/chat/lobby`, auth);
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

  it('closes with 1000 after a failed authentication, as chanx does', async () => {
    const { url } = await serve();
    const client = open(`${url}/ws/chat/lobby`);

    expect((await client.closed).code).toBe(1000);
    expect(client.frames).toMatchObject([
      { action: 'authentication', payload: { status_code: 401 } },
    ]);
  });

  it('closes with 1011 when connecting fails on the server', async () => {
    const { url } = await serve();
    expect((await open(`${url}/ws/broken`).closed).code).toBe(1011);
  });

  it('runs onDisconnect when the client goes away', async () => {
    const { url } = await serve();
    const client = open(`${url}/ws/chat/lobby`, auth);
    await client.next(1);

    client.ws.close();

    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce());
  });

  it('refuses an upgrade for a path no consumer serves when nothing else listens', async () => {
    const { url } = await serve();
    await expect(open(`${url}/elsewhere`).opened).rejects.toThrow();
  });

  it('leaves other upgrades to another WebSocket server on the same HTTP server', async () => {
    const { server, url } = await serve();
    const other = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (request.url === '/other')
        other.handleUpgrade(request, socket, head, (ws) => ws.send('"other"'));
    });
    cleanups.push(() => new Promise((resolve) => other.close(resolve)));

    const client = open(`${url}/other`);
    await client.next(1);
    expect(client.frames).toEqual(['other']);

    const chanxClient = open(`${url}/ws/chat/lobby`, auth);
    await chanxClient.next(1);
  });

  it('closes every socket with 1001 when detached', async () => {
    const { url, attachment } = await serve();
    const client = open(`${url}/ws/chat/lobby`, auth);
    await client.next(1);

    await attachment.close();

    expect((await client.closed).code).toBe(1001);
  });

  it('drops a client that stops answering pings, and keeps one that answers', async () => {
    const { url } = await serve(undefined, 30);
    const silent = open(`${url}/ws/chat/lobby`, { ...auth, autoPong: false });
    const healthy = open(`${url}/ws/chat/lobby`, auth);
    await Promise.all([silent.opened, healthy.opened]);

    expect((await silent.closed).code).toBe(1006);
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('takes JSON sent as a binary frame', async () => {
    const { url } = await serve();
    const client = open(`${url}/ws/chat/lobby`, auth);
    await client.opened;

    client.ws.send(Buffer.from(JSON.stringify({ action: 'ping' })), { binary: true });

    await client.next(2);
    expect(client.frames[1]).toEqual({ action: 'pong', payload: null });
  });
});

describe('with @chanx-js/client', () => {
  type ToServer =
    { action: 'ping'; payload: null } | { action: 'chat'; payload: { text: string } };
  type ToClient =
    { action: 'pong'; payload: null } | { action: 'notice'; payload: { text: string } };
  const descriptor = defineChannel<ToServer, ToClient>()({
    name: 'chat',
    address: '/ws/chat/{room}',
    heartbeat: true,
  });

  it('requests, receives and heartbeats against the Node server', async () => {
    const { url } = await serve();
    const client = createClient({
      baseUrl: url,
      socketFactory: (address) => new WebSocket(address, auth) as never,
    });
    const connection = client.connect(descriptor, { params: { room: 'lobby' } });
    cleanups.push(() => client.closeAll());

    expect(await connection.request({ action: 'ping', payload: null })).toEqual({
      action: 'pong',
      payload: null,
    });
    expect(await connection.request({ action: 'chat', payload: { text: 'hi' } })).toEqual(
      {
        action: 'notice',
        payload: { text: 'lobby: hi' },
      },
    );
  });

  it('rejects a request the server answers with an error', async () => {
    const { url } = await serve();
    const client = createClient({
      baseUrl: url,
      socketFactory: (address) => new WebSocket(address, auth) as never,
    });
    const connection = client.connect(descriptor, { params: { room: 'lobby' } });
    cleanups.push(() => client.closeAll());

    await expect(
      connection.request({ action: 'chat', payload: {} } as never),
    ).rejects.toBeInstanceOf(ChanxRequestError);
  });
});
