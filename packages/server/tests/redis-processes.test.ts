import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Posted, Said, chat, redisApp, roomTopic } from './fixtures/redis-app';

const url = process.env.REDIS_URL;
const fixture = fileURLToPath(new URL('./fixtures/redis-app.ts', import.meta.url));

async function startServer(): Promise<{ port: number; process: ChildProcess }> {
  const child = spawn(
    process.execPath,
    ['--conditions=@chanx-js/source', '--import', 'tsx', fixture],
    {
      // `--import tsx` resolves from here, where tsx is a dependency.
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, REDIS_URL: url },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const port = await new Promise<number>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
    child.stdout!.on('data', (data: Buffer) => {
      const match = /port=(\d+)/.exec(String(data));
      if (match) resolve(Number(match[1]));
    });
  });
  return { port, process: child };
}

async function join(port: number, path: string) {
  const frames: Array<Record<string, unknown>> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const next = async (action: string) => {
    await expect
      .poll(() => frames.some((f) => f.action === action), { timeout: 5000 })
      .toBe(true);
    return frames.splice(
      frames.findIndex((f) => f.action === action),
      1,
    )[0]!;
  };
  // A reply to a ping means the connection is set up, groups joined.
  socket.send(JSON.stringify({ action: 'ping', payload: null }));
  await next('pong');
  return { socket, frames, next };
}

describe.skipIf(!url)('two server processes on one Redis', () => {
  const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];

  beforeAll(async () => {
    servers.push(...(await Promise.all([startServer(), startServer()])));
  }, 30_000);

  afterAll(() => {
    for (const server of servers) server.process.kill();
  });

  it('broadcasts from a client on one to a client on the other', async () => {
    const [a, b] = servers;
    const ann = await join(a!.port, '/ws/chat/lobby');
    const bob = await join(b!.port, '/ws/chat/lobby');

    ann.socket.send(JSON.stringify({ action: 'say', payload: { text: 'hi bob' } }));

    expect(await bob.next('said')).toMatchObject({ payload: { text: 'hi bob' } });
    ann.socket.close();
    bob.socket.close();
  });

  it('reaches both processes from a third, as a worker would', async () => {
    const [a, b] = servers;
    const ann = await join(a!.port, '/ws/chat/workers');
    const bob = await join(b!.port, '/ws/chat/workers');

    const worker = redisApp(url!);
    try {
      await worker.chanx.broadcastEvent(chat, Said.create({ text: 'from a worker' }), [
        'room.workers',
      ]);

      for (const client of [ann, bob]) {
        expect(await client.next('said')).toMatchObject({
          payload: { text: 'from a worker' },
        });
      }
    } finally {
      await worker.layer.flush();
      ann.socket.close();
      bob.socket.close();
    }
  });

  it('publishes a topic to its subscribers on every process', async () => {
    const [a, b] = servers;
    const ann = await join(a!.port, '/ws/chat/topics');
    const bob = await join(b!.port, '/ws/chat/topics');
    for (const client of [ann, bob]) {
      client.socket.send(
        JSON.stringify({
          action: 'subscribe',
          topic: 'room:lobby',
          ref: 's',
          payload: null,
        }),
      );
      await client.next('subscribed');
    }

    const worker = redisApp(url!);
    try {
      await worker.chanx.publish(
        roomTopic,
        roomTopic.with({ name: 'lobby' }),
        Posted.create({ body: 'hello' }),
      );

      for (const client of [ann, bob]) {
        expect(await client.next('posted')).toMatchObject({
          topic: 'room:lobby',
          payload: { body: 'hello' },
        });
      }
    } finally {
      await worker.layer.flush();
      ann.socket.close();
      bob.socket.close();
    }
  });
});
