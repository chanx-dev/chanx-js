import { InMemoryChannelLayer } from '@chanx-js/layers';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ChanxOptions } from '../src';
import {
  AuthenticationError,
  PingMessage,
  PongMessage,
  consumer,
  createChanx,
  defineMessage,
} from '../src';
import { connect } from '../src/testing';

const Chat = defineMessage('chat', z.object({ message_text: z.string() }));
const Notice = defineMessage('notice', z.object({ text: z.string() }));
const Slow = defineMessage('slow');

const chat = consumer('/ws/chat/{room}', { name: 'chat', emits: [Notice] })
  .on(PingMessage, { output: PongMessage }, () => PongMessage.create())
  .on(Chat, async (m, ctx) => {
    await ctx.send(
      Notice.create({ text: `${ctx.params.room}: ${m.payload.message_text}` }),
    );
  });

function app(options: Partial<ChanxOptions> = {}) {
  const logger = { error: vi.fn(), warn: vi.fn() };
  return { logger, chanx: createChanx({ consumers: [chat], logger, ...options }) };
}

describe('replies', () => {
  it('sends a reply with no envelope for a frame without a ref, as chanx does', async () => {
    const client = connect(app().chanx, '/ws/chat/lobby');
    client.send({ action: 'ping' });
    expect(await client.receive()).toEqual({ action: 'pong', payload: null });
  });

  it('echoes the ref, with the envelope version, on every reply to a frame', async () => {
    const client = connect(app().chanx, '/ws/chat/lobby');
    expect(await client.request({ action: 'ping' })).toEqual({
      action: 'pong',
      payload: null,
      version: 1,
      ref: 'test-1',
    });
    expect(await client.request(Chat.create({ message_text: 'hi' }))).toMatchObject({
      action: 'notice',
      payload: { text: 'lobby: hi' },
      ref: 'test-2',
    });
  });

  it('routes by path and decodes its params', async () => {
    const client = connect(app().chanx, '/ws/chat/sales%20team');
    client.send(Chat.create({ message_text: 'hi' }));
    expect(await client.receive()).toMatchObject({ payload: { text: 'sales team: hi' } });
  });

  it('serves nothing for a path no consumer matches', () => {
    expect(() => connect(app().chanx, '/ws/chat/a/b')).toThrow('No consumer serves');
    expect(app().chanx.match('/ws/chat/lobby')).toBe(true);
  });

  it('lets a push go out without the ref of the frame being handled', async () => {
    const Both = defineMessage('both');
    const chanx = createChanx({
      consumers: [
        consumer('/ws', { name: 'both', emits: [Notice] }).on(Both, async (_m, ctx) => {
          await ctx.push(Notice.create({ text: 'push' }));
          await ctx.send(Notice.create({ text: 'reply' }));
        }),
      ],
    });
    const client = connect(chanx, '/ws');
    client.send({ action: 'both', version: 1, ref: 'r' });
    expect(await client.receive()).toEqual({
      action: 'notice',
      payload: { text: 'push' },
    });
    expect(await client.receive()).toMatchObject({
      payload: { text: 'reply' },
      ref: 'r',
    });
  });
});

describe('errors', () => {
  it('answers a frame that fails validation with the issues, under its ref', async () => {
    const client = connect(app().chanx, '/ws/chat/lobby');
    expect(await client.request({ action: 'chat' })).toEqual({
      action: 'error',
      payload: [{ type: 'missing', loc: ['chat', 'payload'], msg: 'Field required' }],
      version: 1,
      ref: 'test-1',
    });
  });

  it('answers a malformed envelope without a ref, since the ref itself is suspect', async () => {
    const client = connect(app().chanx, '/ws/chat/lobby');
    client.send({ action: 'ping', ref: 5 });
    expect(await client.receive()).toEqual({
      action: 'error',
      payload: [
        { type: 'string_type', loc: ['ref'], msg: 'Input should be a valid string' },
      ],
    });
  });

  it('answers a frame that is not JSON text as chanx does, keeping the connection', async () => {
    const sent: string[] = [];
    const session = app().chanx.connect(
      { url: '/ws/chat/lobby' },
      { send: (data) => sent.push(data), close() {} },
    )!;
    session.receive('{not json');
    session.receive(new TextEncoder().encode(JSON.stringify({ action: 'ping' })));
    session.receive(JSON.stringify({ action: 'ping' }));

    await vi.waitFor(() => expect(sent).toHaveLength(3));
    const [invalid, binary, pong] = sent.map((data) => JSON.parse(data));
    // msg carries the JSON parser's own reason, which differs from Python's.
    expect(invalid).toMatchObject({
      action: 'error',
      payload: [
        { type: 'json_invalid', loc: [], msg: expect.stringMatching(/^Invalid JSON: /) },
      ],
    });
    expect(binary).toEqual({
      action: 'error',
      payload: [
        {
          type: 'json_invalid',
          loc: [],
          msg: 'Invalid JSON: binary frames are not supported',
        },
      ],
    });
    expect(pong).toEqual({ action: 'pong', payload: null });
  });

  it('reports a failing handler generically and logs the cause', async () => {
    const Boom = defineMessage('boom');
    const logger = { error: vi.fn(), warn: vi.fn() };
    const chanx = createChanx({
      logger,
      consumers: [
        consumer('/ws', { name: 'boom' }).on(Boom, () => {
          throw new Error('secret detail');
        }),
      ],
    });
    const client = connect(chanx, '/ws');
    expect(await client.request({ action: 'boom' })).toMatchObject({
      action: 'error',
      payload: { detail: 'Failed to process message for boom' },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('boom'),
      expect.any(Error),
    );
  });

  it('answers any message on a consumer without handlers', async () => {
    const chanx = createChanx({
      consumers: [consumer('/ws', { name: 'empty' })],
      logger: { error() {}, warn() {} },
    });
    const client = connect(chanx, '/ws');
    client.send({ action: 'ping' });
    expect(await client.receive()).toEqual({
      action: 'error',
      payload: { detail: 'Failed to process message' },
    });
  });
});

describe('completion', () => {
  it('follows each handled frame with complete, errors included', async () => {
    const client = connect(app({ sendCompletion: true }).chanx, '/ws/chat/lobby');
    client.send({ action: 'ping', version: 1, ref: 'a' });
    expect(await client.receiveUntil('complete')).toEqual([
      { action: 'pong', payload: null, version: 1, ref: 'a' },
      { action: 'complete', payload: null, version: 1, ref: 'a' },
    ]);
    client.send({ action: 'nope' });
    expect((await client.receiveUntil('complete')).map((frame) => frame.action)).toEqual([
      'error',
      'complete',
    ]);
  });
});

describe('camelize', () => {
  it('decamelizes what arrives and camelizes what leaves, keys only', async () => {
    const Echo = defineMessage('echo_back', z.object({ user_name: z.string() }));
    const chanx = createChanx({
      camelize: true,
      consumers: [
        consumer('/ws', { name: 'echo' }).on(Echo, { output: Echo }, (m) =>
          Echo.create(m.payload),
        ),
      ],
    });
    const client = connect(chanx, '/ws');
    client.send({ action: 'echo_back', payload: { userName: 'ann' } });
    expect(await client.receive()).toEqual({
      action: 'echo_back',
      payload: { userName: 'ann' },
    });
  });
});

describe('connection lifecycle', () => {
  it('gives each connection its own state, with the request at hand', async () => {
    const Count = defineMessage('count');
    const Counted = defineMessage(
      'counted',
      z.object({ n: z.number(), who: z.string() }),
    );
    const chanx = createChanx({
      consumers: [
        consumer('/ws', {
          name: 'counter',
          state: (conn) => ({
            n: 0,
            who: conn.url.searchParams.get('who') ?? conn.headers.get('x-who')!,
          }),
        }).on(Count, { output: Counted }, (_m, ctx) =>
          Counted.create({ n: ++ctx.state.n, who: ctx.state.who }),
        ),
      ],
    });
    const ann = connect(chanx, '/ws?who=ann');
    const bob = connect(chanx, '/ws', { headers: { 'x-who': 'bob' } });
    ann.send({ action: 'count' });
    ann.send({ action: 'count' });
    bob.send({ action: 'count' });

    expect((await ann.receive()).payload).toEqual({ n: 1, who: 'ann' });
    expect((await ann.receive()).payload).toEqual({ n: 2, who: 'ann' });
    expect((await bob.receive()).payload).toEqual({ n: 1, who: 'bob' });
  });

  it('runs onConnect before any frame and onDisconnect once, aborting ctx.signal', async () => {
    const events: string[] = [];
    let signal: AbortSignal | undefined;
    const chanx = createChanx({
      consumers: [
        consumer('/ws', {
          name: 'life',
          onConnect: async (ctx) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            signal = ctx.signal;
            events.push('connect');
          },
          onDisconnect: () => void events.push('disconnect'),
        }).on(PingMessage, () => void events.push('ping')),
      ],
    });
    const client = connect(chanx, '/ws');
    client.send({ action: 'ping' });
    await vi.waitFor(() => expect(events).toEqual(['connect', 'ping']));

    client.close();
    client.close();
    expect(events).toEqual(['connect', 'ping', 'disconnect']);
    expect(signal?.aborted).toBe(true);
  });

  it('closes with 1011 and serves nothing when connecting fails', async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const chanx = createChanx({
      logger,
      consumers: [
        consumer('/ws', {
          name: 'broken',
          state: () => {
            throw new Error('no database');
          },
        }).on(PingMessage, { output: PongMessage }, () => PongMessage.create()),
      ],
    });
    const client = connect(chanx, '/ws');
    client.send({ action: 'ping' });

    expect(await client.closed).toEqual({ code: 1011, reason: undefined });
    expect(logger.error).toHaveBeenCalledWith(
      'chanx: connecting failed',
      expect.any(Error),
    );
    expect(client.pending).toEqual([]);
  });

  it('handles frames concurrently, so a slow one blocks none', async () => {
    let release!: () => void;
    const chanx = createChanx({
      consumers: [
        consumer('/ws', { name: 'slow' })
          .on(Slow, { output: PongMessage }, async () => {
            await new Promise<void>((resolve) => (release = resolve));
            return PongMessage.create();
          })
          .on(PingMessage, { output: PongMessage }, () => PongMessage.create()),
      ],
    });
    const client = connect(chanx, '/ws');
    client.send({ action: 'slow', version: 1, ref: 'slow' });
    client.send({ action: 'ping', version: 1, ref: 'fast' });

    expect((await client.receive()).ref).toBe('fast');
    release();
    expect((await client.receive()).ref).toBe('slow');
  });
});

describe('authentication', () => {
  const guarded = (authenticate: Parameters<typeof consumer>[1]['authenticate']) =>
    createChanx({
      logger: { error: vi.fn(), warn: vi.fn() },
      consumers: [
        consumer('/ws', { name: 'guarded', authenticate }).on(
          PingMessage,
          { output: PongMessage },
          () => PongMessage.create(),
        ),
      ],
    });

  it('tells the client it passed, then serves frames sent while it was checking', async () => {
    const client = connect(
      guarded(async ({ headers }) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return headers.get('authorization') === 'Bearer ok' ? { id: 1 } : false;
      }),
      '/ws',
      { headers: { authorization: 'Bearer ok' } },
    );
    client.send({ action: 'ping' });

    expect(await client.receive()).toEqual({
      action: 'authentication',
      payload: { status_code: 200, status_text: 'OK', data: { detail: 'OK' } },
    });
    expect(await client.receive()).toEqual({ action: 'pong', payload: null });
  });

  it('tells the client why it failed and closes, serving nothing', async () => {
    const client = connect(
      guarded(() => false),
      '/ws',
    );
    client.send({ action: 'ping' });

    expect(await client.receive()).toEqual({
      action: 'authentication',
      payload: {
        status_code: 401,
        status_text: 'Unauthorized',
        data: { detail: 'Authentication credentials were not provided.' },
      },
    });
    expect((await client.closed).code).toBe(4401);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.pending).toEqual([]);
  });

  it('uses the status an AuthenticationError carries, closing with 4000 + it', async () => {
    const client = connect(
      guarded(() => {
        throw new AuthenticationError({
          status: 403,
          statusText: 'Forbidden',
          data: { detail: 'No.' },
        });
      }),
      '/ws',
    );
    expect((await client.receive()).payload).toEqual({
      status_code: 403,
      status_text: 'Forbidden',
      data: { detail: 'No.' },
    });
    expect((await client.closed).code).toBe(4403);
  });

  it('closes with 4500, without a word, when authenticate itself crashes, as chanx does', async () => {
    const client = connect(
      guarded(() => {
        throw new Error('db down');
      }),
      '/ws',
    );
    expect((await client.closed).code).toBe(4500);
    expect(client.pending).toEqual([]);
  });

  it('exposes the authenticated user on the connection', async () => {
    const Who = defineMessage('who');
    const Me = defineMessage('me', z.object({ id: z.number() }));
    const chanx = createChanx({
      consumers: [
        consumer('/ws', { name: 'me', authenticate: () => ({ id: 7 }) }).on(
          Who,
          { output: Me },
          (_m, ctx) => Me.create({ id: ctx.conn.user.id }),
        ),
      ],
    });
    const client = connect(chanx, '/ws');
    client.send({ action: 'who' });
    await client.receive();
    expect((await client.receive()).payload).toEqual({ id: 7 });
  });

  it('authenticates the very connection it then serves', async () => {
    const authenticated: object[] = [];
    const connected: object[] = [];
    const chanx = createChanx({
      consumers: [
        consumer('/ws', {
          name: 'same',
          authenticate: (request) => (authenticated.push(request), { id: 1 }),
          onConnect: (ctx) => void connected.push(ctx.conn),
        }),
      ],
    });
    await connect(chanx, '/ws').ready;
    expect(authenticated[0]).toBe(connected[0]);
  });
});

describe('topic frames, with no topics mounted', () => {
  it.each([
    [
      'subscribe',
      {
        action: 'error',
        payload: { reason: 'unknown_topic', detail: "Unknown topic 'room:1'" },
      },
    ],
    [
      'post',
      {
        action: 'error',
        payload: { reason: 'not_subscribed', detail: "Not subscribed to 'room:1'" },
      },
    ],
    ['unsubscribe', { action: 'unsubscribed', payload: null }],
  ])('answers %s as chanx answers an unknown topic', async (action, expected) => {
    const client = connect(app().chanx, '/ws/chat/lobby');
    client.send({ action, version: 1, topic: 'room:1', ref: 'r' });
    expect(await client.receive()).toEqual({
      ...expected,
      version: 1,
      topic: 'room:1',
      ref: 'r',
    });
  });
});

describe('dev warning', () => {
  const Undeclared = defineMessage('undeclared');
  const make = (dev: boolean) => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const chanx = createChanx({
      dev,
      logger,
      consumers: [
        consumer('/ws', { name: 'loose', emits: [PongMessage] })
          .on(Undeclared, () => PongMessage.create())
          .on(PingMessage, { output: PongMessage }, () => PongMessage.create()),
      ],
    });
    return { logger, client: connect(chanx, '/ws') };
  };

  it('warns once when a handler returns a message it does not declare', async () => {
    const { logger, client } = make(true);
    for (const action of ['undeclared', 'undeclared', 'ping']) {
      client.send({ action });
      await client.receive();
    }
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('undeclared returned "pong"'),
    );
  });

  it('stays quiet outside development', async () => {
    const { logger, client } = make(false);
    client.send({ action: 'undeclared' });
    await client.receive();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('a client that leaves while connecting', () => {
  it('closes the layer channel it was given, and never connects', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const closed = vi.fn();
    class Slow extends InMemoryChannelLayer {
      override async newChannel(...args: Parameters<InMemoryChannelLayer['newChannel']>) {
        await held;
        const channel = await super.newChannel(...args);
        const close = channel.close.bind(channel);
        channel.close = async () => {
          closed();
          await close();
        };
        return channel;
      }
    }
    const onConnect = vi.fn();
    const leaving = consumer('/ws/leaving', { name: 'leaving', onConnect });
    const client = connect(
      createChanx({ consumers: [leaving], layers: { default: new Slow() } }),
      '/ws/leaving',
    );

    await client.close();
    release();

    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(onConnect).not.toHaveBeenCalled();
  });
});
