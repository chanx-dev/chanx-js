import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

import type { AsyncAPIDocument } from '../src';
import {
  PingMessage,
  PongMessage,
  asyncapiHandler,
  consumer,
  createChanx,
  defineMessage,
} from '../src';
import { asyncapiMiddleware } from '../src/node';

const chat = consumer('/ws/chat', {
  name: 'chat',
  description: 'Say </script><script>alert(1)</script>',
}).on(PingMessage, { output: PongMessage }, () => PongMessage.create());

const logger = { error: vi.fn(), warn() {} };
const app = () => createChanx({ consumers: [chat], logger });
const get = (url: string, init?: RequestInit) => new Request(url, init);

afterEach(() => {
  logger.error.mockClear();
  vi.doUnmock('yaml');
});

describe('asyncapiHandler', () => {
  it("serves the JSON document, its server taken from the request, as chanx's views do", async () => {
    const handle = asyncapiHandler(app(), { title: 'Chat API' });
    const response = (await handle(get('https://api.example.com/asyncapi.json')))!;

    const document = (await response.json()) as AsyncAPIDocument;
    expect(document.info.title).toBe('Chat API');
    expect(document.servers).toEqual({
      production: { host: 'api.example.com', protocol: 'wss' },
    });
    expect(Object.keys(document.operations)).toEqual(['handle_ping']);
  });

  it('lets options override the server taken from the request', async () => {
    const handle = asyncapiHandler(app(), {
      serverUrl: 'ws.example.com',
      serverProtocol: 'wss',
    });
    const document = (await (await handle(
      get('http://localhost/asyncapi.json'),
    ))!.json()) as AsyncAPIDocument;
    expect(document.servers).toEqual({
      production: { host: 'ws.example.com', protocol: 'wss' },
    });
  });

  it('serves the same document as YAML', async () => {
    const handle = asyncapiHandler(app());
    const json = await (await handle(get('http://localhost/asyncapi.json')))!.json();
    const response = (await handle(get('http://localhost/asyncapi.yaml')))!;

    expect(response.headers.get('content-type')).toBe('application/x-yaml');
    expect(parse(await response.text())).toEqual(json);
  });

  it('answers 400 for YAML without the yaml package, as chanx does without PyYAML', async () => {
    vi.doMock('yaml', () => {
      throw new Error('Cannot find package');
    });
    const response = (await asyncapiHandler(app())(
      get('http://localhost/asyncapi.yaml'),
    ))!;

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'YAML format not available. Please install yaml: npm install yaml',
    });
  });

  it('renders the docs page, escaping the document so it cannot end the script', async () => {
    const response = (await asyncapiHandler(app(), { title: 'A <b> API' })(
      get('http://localhost/asyncapi'),
    ))!;
    const page = await response.text();

    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page).toContain('<title>A &lt;b&gt; API</title>');
    expect(page).toContain('AsyncApiStandalone.render');
    expect(page).not.toContain('</script><script>alert(1)');
    expect(page).toContain('\\u003c/script>');
  });

  it('serves under another path, and leaves other paths and methods alone', async () => {
    const handle = asyncapiHandler(app(), { path: '/docs/ws' });

    expect((await handle(get('http://localhost/docs/ws.json')))!.status).toBe(200);
    expect(await handle(get('http://localhost/asyncapi.json'))).toBeUndefined();
    expect(
      await handle(get('http://localhost/docs/ws', { method: 'POST' })),
    ).toBeUndefined();
  });

  it('reports a document that cannot be generated: 500, logged', async () => {
    const A = defineMessage('a', z.object({ x: z.string() }).meta({ title: 'Same' }));
    const B = defineMessage('b', z.object({ y: z.number() }).meta({ title: 'Same' }));
    const broken = createChanx({
      consumers: [
        consumer('/ws/x', { name: 'x' })
          .on(A, () => {})
          .on(B, () => {}),
      ],
      logger,
    });
    const handle = asyncapiHandler(broken);

    const json = (await handle(get('http://localhost/asyncapi.json')))!;
    expect(json.status).toBe(500);
    expect(await json.json()).toEqual({
      error: expect.stringMatching(/^Failed to generate schema: Two different schemas/),
    });
    const page = (await handle(get('http://localhost/asyncapi')))!;
    expect(page.status).toBe(500);
    expect(await page.text()).toContain('Failed to generate schema');
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});

describe('asyncapiMiddleware', () => {
  async function serve(next?: boolean) {
    const middleware = asyncapiMiddleware(app());
    const server = createServer((request, response) =>
      middleware(
        request,
        response,
        next ? () => response.writeHead(200).end('next') : undefined,
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  it('serves the document on a Node server, its host taken from the request', async () => {
    const { url, close } = await serve();
    try {
      const response = await fetch(`${url}/asyncapi.json`);
      const document = (await response.json()) as AsyncAPIDocument;
      expect(document.servers).toEqual({
        development: { host: url.slice('http://'.length), protocol: 'ws' },
      });
      const head = await fetch(`${url}/asyncapi`, { method: 'HEAD' });
      expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await head.text()).toBe('');
    } finally {
      close();
    }
  });

  it('passes other requests to next, or answers 404 without one', async () => {
    const withNext = await serve(true);
    const without = await serve();
    try {
      expect(await (await fetch(`${withNext.url}/other`)).text()).toBe('next');
      expect((await fetch(`${without.url}/other`)).status).toBe(404);
    } finally {
      withNext.close();
      without.close();
    }
  });
});
