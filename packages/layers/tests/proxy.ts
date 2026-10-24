import type { AddressInfo, Socket } from 'node:net';
import { connect, createServer } from 'node:net';

/** A TCP proxy to Redis that refuses connections on demand, to stage failures. */
export async function redisProxy(target: string) {
  const { hostname, port } = new URL(target);
  const sockets = new Set<Socket>();
  const proxy = {
    attempts: 0,
    refuse: (_attempt: number) => false,
    get open() {
      return sockets.size;
    },
    url: '',
    /** Cut every open connection but keep accepting new ones, as a Redis restart does. */
    drop: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  const server = createServer((client) => {
    proxy.attempts += 1;
    if (proxy.refuse(proxy.attempts)) return client.destroy();
    const upstream = connect(Number(port), hostname);
    sockets.add(client);
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => client.destroy());
    client.on('error', () => {});
    upstream.on('error', () => {});
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy.url = `redis://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return proxy;
}
