// The built packages on Bun or Deno, through that runtime's crossws and Hono adapters.
// Run after `pnpm build`: bun tests/runtimes/smoke.mjs, or deno run -A tests/runtimes/smoke.mjs
import { createClient, defineChannel, defineTopic } from '@chanx-js/client';
import {
  PingMessage,
  PongMessage,
  consumer,
  createChanx,
  defineMessage,
  topic,
} from '@chanx-js/server';
import { chanxHooks } from '@chanx-js/server/crossws';
import { chanxHono } from '@chanx-js/server/hono';
import { Hono } from 'hono';
import { z } from 'zod';

const runtime = globalThis.Bun ? 'bun' : globalThis.Deno ? 'deno' : undefined;
if (!runtime) throw new Error('Run this on Bun or Deno');

const Post = defineMessage('post', z.object({ body: z.string() }));
const Posted = defineMessage('posted', z.object({ body: z.string() }));
const RoomEvent = defineMessage('room_event', z.object({ body: z.string() }));
const Say = defineMessage('say', z.object({ text: z.string() }));
const Said = defineMessage('said', z.object({ text: z.string() }));

const room = topic('room:{room_name}')
  .on(Post, { output: Posted }, async (m, ctx) => {
    await ctx.publish(RoomEvent.create(m.payload), { seq: 7 });
    return Posted.create(m.payload);
  })
  .passthrough(RoomEvent);
const hub = consumer('/ws/hub', {
  name: 'hub',
  emits: [Said],
  groups: ['all'],
  topics: [room],
})
  .on(PingMessage, { output: PongMessage }, () => PongMessage.create())
  .on(Say, (m, ctx) => ctx.broadcast(Said.create(m.payload), { excludeCurrent: true }));
const guarded = consumer('/ws/guarded', {
  name: 'guarded',
  authenticate: ({ url }) => (url.searchParams.get('token') === 'ok' ? { id: 1 } : false),
  rejectBeforeUpgrade: true,
});
const app = () =>
  createChanx({ consumers: [hub, guarded], logger: { error() {}, warn() {} } });

const roomTopic = defineTopic()({ name: 'room_topic', pattern: 'room:{room_name}' });
const hubChannel = defineChannel()({
  name: 'hub',
  address: '/ws/hub',
  topics: { roomTopic },
});

async function startCrossws(chanx) {
  if (runtime === 'bun') {
    const { default: bunAdapter } = await import('crossws/adapters/bun');
    const ws = bunAdapter({ hooks: chanxHooks(chanx) });
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      websocket: ws.websocket,
      fetch: (request, server) => ws.handleUpgrade(request, server),
    });
    return { port: server.port, stop: () => server.stop(true) };
  }
  const { default: denoAdapter } = await import('crossws/adapters/deno');
  const ws = denoAdapter({ hooks: chanxHooks(chanx) });
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen() {} },
    (request, info) => ws.handleUpgrade(request, info),
  );
  return { port: server.addr.port, stop: () => server.shutdown() };
}

async function startHono(chanx) {
  const hono = new Hono();
  if (runtime === 'bun') {
    const { upgradeWebSocket, websocket } = await import('hono/bun');
    hono.get('/ws/*', chanxHono(chanx, upgradeWebSocket));
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: hono.fetch,
      websocket,
    });
    return { port: server.port, stop: () => server.stop(true) };
  }
  const { upgradeWebSocket } = await import('hono/deno');
  hono.get('/ws/*', chanxHono(chanx, upgradeWebSocket));
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen() {} },
    hono.fetch,
  );
  return { port: server.addr.port, stop: () => server.shutdown() };
}

function check(condition, what) {
  if (!condition) throw new Error(`failed: ${what}`);
}

function within(promise, what, ms = 3000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out: ${what}`)), ms),
    ),
  ]);
}

/** Resolves with whether the socket opened, and the first frame if one arrives. */
function rawSocket(url, send) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => send?.(ws);
    ws.onmessage = (event) => {
      resolve({ opened: true, frame: JSON.parse(event.data) });
      ws.close();
    };
    ws.onerror = () => resolve({ opened: false });
    ws.onclose = () => resolve({ opened: false });
  });
}

async function scenarios(baseUrl) {
  const client = createClient({ baseUrl, heartbeat: false, closeDelay: 0 });
  try {
    const connection = client.connect(hubChannel);
    const pong = await within(
      connection.request({ action: 'ping', payload: null }),
      'ping',
    );
    check(pong.action === 'pong', 'ping is answered with pong');

    const handle = connection.topic(roomTopic.with({ room_name: 'lobby' }));
    const event = new Promise((resolve) =>
      handle.on('room_event', (message, envelope) => resolve([message, envelope.seq])),
    );
    await within(handle.subscribe(), 'subscribe');
    const posted = await within(
      handle.request({ action: 'post', payload: { body: 'hi' } }),
      'post',
    );
    check(posted.payload.body === 'hi', 'a topic request is answered');
    const [message, seq] = await within(event, 'topic event');
    check(
      message.payload.body === 'hi' && seq === 7,
      'a topic event arrives with its seq',
    );

    // Its own socket: the client shares one per URL for a channel with topics.
    const other = client.connect(hubChannel, { share: false });
    await within(other.ready(), 'second connection');
    const heard = within(other.once('said'), 'broadcast');
    connection.send({ action: 'say', payload: { text: 'hello' } });
    check(
      (await heard).payload.text === 'hello',
      "a broadcast reaches the group's others",
    );
    other.close();
  } finally {
    client.closeAll();
  }

  const refused = await within(rawSocket(`${baseUrl}/ws/guarded`), 'refused upgrade');
  check(!refused.opened, 'rejectBeforeUpgrade refuses before the socket opens');
  const allowed = await within(
    rawSocket(`${baseUrl}/ws/guarded?token=ok`),
    'allowed upgrade',
  );
  check(
    allowed.frame?.payload?.status_code === 200,
    'an authenticated upgrade is served',
  );

  const binary = await within(
    rawSocket(`${baseUrl}/ws/hub`, (ws) =>
      ws.send(new TextEncoder().encode('{"action":"ping"}')),
    ),
    'binary frame',
  );
  check(binary.frame?.payload?.[0]?.type === 'json_invalid', 'a binary frame is refused');
}

let failed = false;
for (const [name, start] of [
  ['crossws', startCrossws],
  ['hono', startHono],
]) {
  const server = await start(app());
  try {
    await scenarios(`ws://127.0.0.1:${server.port}`);
    console.log(`ok   ${runtime} ${name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${runtime} ${name}: ${error.message}`);
  } finally {
    await server.stop();
  }
}
if (failed) {
  if (runtime === 'bun') process.exit(1);
  Deno.exit(1);
}
