import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { z } from 'zod';
import { RedisPubSubChannelLayer } from '@chanx-js/layers/redis';

import {
  PingMessage,
  PongMessage,
  consumer,
  createChanx,
  defineMessage,
  topic,
} from '../../src';
import { attachChanx } from '../../src/adapters/node';

export const Say = defineMessage('say', z.object({ text: z.string() }));
export const Said = defineMessage('said', z.object({ text: z.string() }));
export const Posted = defineMessage('posted', z.object({ body: z.string() }));

export const roomTopic = topic('room:{name}').passthrough(Posted);

export const chat = consumer('/ws/chat/{room}', {
  name: 'chat',
  emits: [Said],
  groups: (conn) => [`room.${conn.params.room}`],
  topics: [roomTopic],
})
  .on(PingMessage, { output: PongMessage }, () => PongMessage.create())
  .on(Say, (m, ctx) => ctx.broadcast(Said.create(m.payload)))
  .passthrough(Said);

export function redisApp(url: string) {
  const layer = new RedisPubSubChannelLayer({ hosts: [url], prefix: 'chanxservertest' });
  return { chanx: createChanx({ consumers: [chat], layers: { default: layer } }), layer };
}

// Run as a process: serve on a free port and print it, for the test to connect to.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = createServer();
  attachChanx(server, redisApp(process.env.REDIS_URL!).chanx);
  server.listen(0, '127.0.0.1', () => {
    console.log(`port=${(server.address() as AddressInfo).port}`);
  });
}
