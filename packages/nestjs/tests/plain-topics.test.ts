import 'reflect-metadata';

import type { AddressInfo } from 'node:net';

import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { defineMessage, topic } from '@chanx-js/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';

import { ChanxConsumer, ChanxModule, ChanxService, ChanxTopic } from '../src';

// A topic as a copied-in kit builds it: plain @chanx-js/server, no Nest class.
const FeedItem = defineMessage('feed_item', z.object({ title: z.string() }));
const FeedTopic = topic('feed:{id}', {
  authorize: ({ params }) => params.id !== 'secret',
}).passthrough(FeedItem);

@ChanxConsumer('/ws/feed', { name: 'feed', topics: [FeedTopic] })
class FeedGateway {}

@Module({ imports: [ChanxModule.forRoot()], providers: [FeedGateway] })
class FeedModule {}

const apps: INestApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function start() {
  const app = await NestFactory.create(FeedModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, url: `ws://127.0.0.1:${port}/ws/feed` };
}

function open(url: string) {
  const ws = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  let refs = 0;
  return {
    frames,
    async request(frame: object) {
      const ref = String(++refs);
      if (ws.readyState !== WebSocket.OPEN)
        await new Promise((resolve) => ws.once('open', resolve));
      ws.send(JSON.stringify({ ...frame, version: 1, ref }));
      return vi.waitFor(() => {
        const reply = frames.find((f) => f.ref === ref);
        if (!reply) throw new Error('no reply yet');
        return reply;
      });
    },
  };
}

describe('plain topics on a Nest consumer', () => {
  it('subscribes, authorizes and publishes through the app ChanxService exposes', async () => {
    const { app, url } = await start();
    const client = open(url);

    expect(await client.request({ action: 'subscribe', topic: 'feed:a' })).toMatchObject({
      action: 'subscribed',
    });
    expect(
      await client.request({ action: 'subscribe', topic: 'feed:secret' }),
    ).toMatchObject({
      action: 'error',
    });

    const { chanx } = app.get(ChanxService);
    await chanx.publish(FeedTopic, 'feed:a', FeedItem.create({ title: 'hello' }));
    await vi.waitFor(() =>
      expect(client.frames).toContainEqual(
        expect.objectContaining({
          action: 'feed_item',
          topic: 'feed:a',
          payload: { title: 'hello' },
        }),
      ),
    );
  });

  it('documents the plain topic in AsyncAPI', async () => {
    const { app } = await start();
    const document = app.get(ChanxService).asyncapi();
    expect(JSON.stringify(document.channels)).toContain('feed:{id}');
  });

  it('still names a @ChanxTopic class that is not a provider', async () => {
    @ChanxTopic('orphan:{id}')
    class OrphanTopic {}

    @ChanxConsumer('/ws/orphans', { name: 'orphans', topics: [OrphanTopic] })
    class OrphanGateway {}

    @Module({ imports: [ChanxModule.forRoot()], providers: [OrphanGateway] })
    class OrphanModule {}

    const app = await NestFactory.create(OrphanModule, { logger: false });
    apps.push(app);
    await expect(app.init()).rejects.toThrow(
      'OrphanTopic is a @ChanxTopic but not a provider',
    );
  });
});
