import 'reflect-metadata';

import type { AddressInfo } from 'node:net';

import {
  type ArgumentsHost,
  type CallHandler,
  Catch,
  type ExceptionFilter,
  ForbiddenException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  type INestApplication,
  Module,
  type Provider,
  type Type,
  Inject,
  type NestInterceptor,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory, REQUEST } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from '@nestjs/websockets';
import { WsAdapter } from '@nestjs/platform-ws';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { io as ioClient } from 'socket.io-client';
import type {
  ConnectRequest,
  Connection,
  Context,
  MessageOf,
  TopicContext,
} from '@chanx-js/server';
import { ErrorMessage, PingMessage, PongMessage, defineMessage } from '@chanx-js/server';
import { IsString, MinLength } from 'class-validator';
import { map } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';

import {
  ChanxConsumer,
  ChanxModule,
  ChanxService,
  ChanxTopic,
  Ctx,
  On,
  OnEvent,
  Payload,
} from '../src';

const Chat = defineMessage('chat', z.object({ text: z.string() }));
const Notice = defineMessage('notice', z.object({ text: z.string() }));
const Secret = defineMessage('secret');
const Shout = defineMessage('shout', z.object({ text: z.string() }));
const Joined = defineMessage('user_joined', z.object({ user: z.string() }));
const Post = defineMessage('post', z.object({ body: z.string() }));
const Posted = defineMessage('posted', z.object({ body: z.string() }));
const RoomEvent = defineMessage('room_event', z.object({ body: z.string() }));
const Refuse = defineMessage('refuse');
const Strict = defineMessage('strict', z.object({ name: z.unknown() }));

@Injectable()
class GreetingService {
  greet(room: string, text: string) {
    return `${room}: ${text}`;
  }

  async userFor(token: string | null) {
    return token === 'ok' ? { name: 'ann' } : false;
  }
}

class NameDto {
  @IsString()
  @MinLength(2)
  name!: string;
}

@Injectable()
class AdminOnly implements CanActivate {
  canActivate(context: ExecutionContext) {
    const ctx = context
      .switchToWs()
      .getClient<Context<string, unknown, { name: string }, never>>();
    return ctx.conn.user.name === 'admin';
  }
}

@Injectable()
class Loud implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      map((reply: MessageOf<typeof Notice>) => ({
        ...reply,
        payload: { text: `${reply.payload.text.toUpperCase()} via ${context.getType()}` },
      })),
    );
  }
}

@ChanxTopic('room:{room_name}', { passthrough: [RoomEvent] })
class RoomTopic {
  constructor(private readonly greeting: GreetingService) {}

  authorize({ params }: { params: Record<string, string> }) {
    return params.room_name !== 'secret';
  }

  @On(Post, { output: Posted })
  async post(
    @Payload() payload: { body: string },
    @Ctx() ctx: TopicContext<'room:{room_name}', unknown, never>,
  ) {
    await ctx.publish(RoomEvent.create(payload));
    return Posted.create({
      body: this.greeting.greet(ctx.params.room_name, payload.body),
    });
  }
}

@ChanxConsumer('/ws/chat/{room}', {
  name: 'chat',
  groups: ['all'],
  topics: [RoomTopic],
  emits: [Notice],
})
class ChatGateway {
  constructor(private readonly greeting: GreetingService) {}

  authenticate({ url }: ConnectRequest) {
    return this.greeting.userFor(url.searchParams.get('token'));
  }

  @On(PingMessage, { output: PongMessage })
  ping() {
    return PongMessage.create();
  }

  @On(Chat, { output: Notice })
  chat(
    @Payload('text') text: string,
    @Ctx() ctx: Context<'/ws/chat/{room}', unknown, unknown, never>,
  ) {
    return Notice.create({ text: this.greeting.greet(ctx.params.room, text) });
  }

  @On(Shout, { output: Notice })
  @UseInterceptors(Loud)
  shout(
    @MessageBody() payload: { text: string },
    @ConnectedSocket() ctx: { ref?: string },
  ) {
    return Notice.create({ text: `${payload.text} (${ctx.ref})` });
  }

  @On(Secret)
  @UseGuards(AdminOnly)
  secret() {}

  @On(Refuse)
  refuse() {
    throw new WsException({ reason: 'closed' });
  }

  @On(Strict, { output: Notice })
  strict(@Payload(new ValidationPipe()) dto: NameDto) {
    return Notice.create({ text: dto.name });
  }

  @OnEvent(Joined, { output: Notice })
  joined(@Payload('user') user: string) {
    return Notice.create({ text: `${user} joined` });
  }
}

@Module({
  imports: [
    ChanxModule.forRoot({
      logger: { error() {}, warn() {} },
      asyncapi: { title: 'Chat' },
    }),
  ],
  providers: [GreetingService, ChatGateway, RoomTopic],
})
class AppModule {}

const apps: INestApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function start(platform: 'express' | 'fastify' = 'express') {
  const app =
    platform === 'express'
      ? await NestFactory.create(AppModule, { logger: false })
      : await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false });
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, url: `ws://127.0.0.1:${port}` };
}

function open(url: string) {
  const ws = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  const closed = new Promise<number>((resolve) => ws.on('close', resolve));
  let refs = 0;
  return {
    ws,
    frames,
    closed,
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

describe('ChanxModule', () => {
  it('serves gateways with injected services, @Payload() and @Ctx()', async () => {
    const { url } = await start();
    const client = open(`${url}/ws/chat/lobby?token=ok`);

    expect(await client.request({ action: 'ping' })).toMatchObject({ action: 'pong' });
    expect(
      await client.request({ action: 'chat', payload: { text: 'hi' } }),
    ).toMatchObject({
      action: 'notice',
      payload: { text: 'lobby: hi' },
    });
  });

  it("authenticates through the gateway's injected service", async () => {
    const { url } = await start();
    const client = open(`${url}/ws/chat/lobby`);
    expect(await client.closed).toBe(4401);
    expect(client.frames[0]).toMatchObject({
      action: 'authentication',
      payload: { status_code: 401 },
    });
  });

  it("runs Nest's interceptors, with @nestjs/websockets' own param decorators", async () => {
    const { url } = await start();
    const client = open(`${url}/ws/chat/lobby?token=ok`);
    expect(
      (await client.request({ action: 'shout', payload: { text: 'hey' } })).payload,
    ).toEqual({
      text: 'HEY (1) via ws',
    });
  });

  it("runs Nest's guards, which see the chanx context as the client", async () => {
    const { url } = await start();
    const client = open(`${url}/ws/chat/lobby?token=ok`);
    expect(await client.request({ action: 'secret' })).toMatchObject({
      action: 'error',
      payload: {
        detail: { message: 'Forbidden resource', statusCode: 403 },
        status_code: 403,
      },
    });
  });

  it('reports a thrown WsException as an error frame', async () => {
    const { url } = await start();
    const client = open(`${url}/ws/chat/lobby?token=ok`);
    expect(await client.request({ action: 'refuse' })).toMatchObject({
      action: 'error',
      payload: { detail: { reason: 'closed' } },
    });
  });

  it("runs Nest's pipes: ValidationPipe on a class-validator DTO", async () => {
    const { url } = await start();
    const client = open(`${url}/ws/chat/lobby?token=ok`);

    expect(
      (await client.request({ action: 'strict', payload: { name: 'ann' } })).payload,
    ).toEqual({ text: 'ann' });
    expect(
      await client.request({ action: 'strict', payload: { name: 'x' } }),
    ).toMatchObject({
      action: 'error',
      payload: {
        detail: { message: ['name must be longer than or equal to 2 characters'] },
        status_code: 400,
      },
    });
  });

  it('broadcasts events and publishes to topics through ChanxService', async () => {
    const { app, url } = await start();
    const service = app.get(ChanxService);
    const client = open(`${url}/ws/chat/lobby?token=ok`);
    await client.request({ action: 'subscribe', topic: 'room:lobby' });

    await service.broadcastEvent(ChatGateway, Joined.create({ user: 'bob' }));
    await service.publish(RoomTopic, 'room:lobby', RoomEvent.create({ body: 'news' }));

    await vi.waitFor(() =>
      expect(client.frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'notice', payload: { text: 'bob joined' } }),
          expect.objectContaining({
            action: 'room_event',
            payload: { body: 'news' },
            topic: 'room:lobby',
          }),
        ]),
      ),
    );
  });

  it('serves topic gateways with injection and authorization', async () => {
    const { url } = await start();
    const client = open(`${url}/ws/chat/lobby?token=ok`);

    expect(
      await client.request({ action: 'subscribe', topic: 'room:secret' }),
    ).toMatchObject({
      payload: { reason: 'unauthorized' },
    });
    await client.request({ action: 'subscribe', topic: 'room:lobby' });
    expect(
      await client.request({
        action: 'post',
        topic: 'room:lobby',
        payload: { body: 'hi' },
      }),
    ).toMatchObject({
      action: 'posted',
      payload: { body: 'lobby: hi' },
    });
  });

  it('documents the gateways in AsyncAPI, operations named after their methods', async () => {
    const { app } = await start();
    const document = app.get(ChanxService).asyncapi() as {
      operations: Record<string, unknown>;
      channels: object;
    };

    expect(Object.keys(document.channels)).toEqual(['chat', 'chat_room_topic']);
    expect(Object.keys(document.operations)).toEqual(
      expect.arrayContaining([
        'ping',
        'chat',
        'shout',
        'secret',
        'refuse',
        'strict',
        'joined',
        'post',
        'handle_passthrough_room_event_message',
      ]),
    );
  });

  it('closes every socket with 1001 when the app shuts down', async () => {
    const { app, url } = await start();
    const client = open(`${url}/ws/chat/lobby?token=ok`);
    await client.request({ action: 'ping' });

    await app.close();
    apps.length = 0;

    expect(await client.closed).toBe(1001);
  });
});

describe('request-scoped gateways', () => {
  const Count = defineMessage('count');
  const Counted = defineMessage(
    'counted',
    z.object({ count: z.number(), room: z.string() }),
  );

  // Request-scoped, with the connection as its REQUEST: one per connection.
  @Injectable({ scope: Scope.REQUEST })
  class Visit {
    count = 0;
    constructor(@Inject(REQUEST) readonly conn: Connection<'/ws/visit/{room}'>) {}
  }

  // Request-scoped through its dependency, as Nest scopes a provider injecting one.
  @ChanxConsumer('/ws/visit/{room}', { name: 'visit' })
  class VisitGateway {
    constructor(private readonly visit: Visit) {}

    authenticate(request: ConnectRequest) {
      return this.visit.conn === request && request.url.searchParams.get('token') === 'ok'
        ? { name: 'ann' }
        : false;
    }

    @On(Count, { output: Counted })
    count() {
      return Counted.create({
        count: ++this.visit.count,
        room: this.visit.conn.params.room,
      });
    }
  }

  @ChanxTopic('counter:{id}')
  @Injectable({ scope: Scope.REQUEST })
  class CounterTopic {
    count = 0;

    authorize({ params }: { params: Record<string, string> }) {
      return params.id !== 'secret';
    }

    @On(Count, { output: Counted })
    next(@Ctx() ctx: TopicContext<'counter:{id}', unknown, never>) {
      return Counted.create({ count: ++this.count, room: ctx.params.id });
    }
  }

  @ChanxConsumer('/ws/counters', { name: 'counters', topics: [CounterTopic] })
  class CountersGateway {}

  async function serve(providers: Provider[]) {
    @Module({
      imports: [ChanxModule.forRoot({ logger: { error() {}, warn() {} } })],
      providers,
    })
    class ScopedModule {}
    const app = await NestFactory.create(ScopedModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    const { port } = app.getHttpServer().address() as AddressInfo;
    return `ws://127.0.0.1:${port}`;
  }

  it('gives each connection its own gateway, kept for every message on it', async () => {
    const url = await serve([Visit, VisitGateway]);
    const first = open(`${url}/ws/visit/lobby?token=ok`);
    const second = open(`${url}/ws/visit/kitchen?token=ok`);

    expect((await first.request({ action: 'count' })).payload).toEqual({
      count: 1,
      room: 'lobby',
    });
    expect((await first.request({ action: 'count' })).payload).toEqual({
      count: 2,
      room: 'lobby',
    });
    expect((await second.request({ action: 'count' })).payload).toEqual({
      count: 1,
      room: 'kitchen',
    });
  });

  it('authenticates on that same gateway, with the connection as REQUEST', async () => {
    const url = await serve([Visit, VisitGateway]);
    const refused = open(`${url}/ws/visit/lobby?token=bad`);
    expect(await refused.closed).toBe(4401);
    expect(refused.frames[0]).toMatchObject({ payload: { status_code: 401 } });
  });

  it('gives each subscription to a request-scoped topic its own instance', async () => {
    const url = await serve([CounterTopic, CountersGateway]);
    const client = open(`${url}/ws/counters`);
    await client.request({ action: 'subscribe', topic: 'counter:a' });
    await client.request({ action: 'subscribe', topic: 'counter:b' });

    const count = (topic: string) =>
      client.request({ action: 'count', topic }).then((frame) => frame.payload);
    expect(await count('counter:a')).toEqual({ count: 1, room: 'a' });
    expect(await count('counter:a')).toEqual({ count: 2, room: 'a' });
    expect(await count('counter:b')).toEqual({ count: 1, room: 'b' });
    expect(
      await client.request({ action: 'subscribe', topic: 'counter:secret' }),
    ).toMatchObject({ payload: { reason: 'unauthorized' } });
  });

  it('refuses to start with a transient gateway, naming it', async () => {
    @ChanxTopic('transient:{id}')
    @Injectable({ scope: Scope.TRANSIENT })
    class TransientTopic {}

    @Module({
      imports: [ChanxModule.forRoot({ logger: { error() {}, warn() {} } })],
      providers: [TransientTopic],
    })
    class TransientModule {}

    const app = await NestFactory.create(TransientModule, { logger: false });
    await expect(app.init()).rejects.toThrow('TransientTopic is transient');
    await app.close();
  });
});

describe.each(['express', 'fastify'] as const)('on Nest with %s', (platform) => {
  it('serves gateways', async () => {
    const { url } = await start(platform);
    const client = open(`${url}/ws/chat/lobby?token=ok`);
    expect(await client.request({ action: 'ping' })).toMatchObject({ action: 'pong' });
  });

  it('serves the AsyncAPI docs page and document when asked', async () => {
    const { url } = await start(platform);
    const http = url.replace('ws://', 'http://');

    const document = (await (await fetch(`${http}/asyncapi.json`)).json()) as {
      info: { title: string };
      channels: object;
    };
    expect(document.info.title).toBe('Chat');
    expect(Object.keys(document.channels)).toEqual(['chat', 'chat_room_topic']);

    const page = await fetch(`${http}/asyncapi`);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toContain('AsyncApiStandalone.render');
    expect((await fetch(`${http}/asyncapi.yaml`)).status).toBe(200);
  });
});

describe('ChanxModule.forRootAsync', () => {
  @Injectable()
  class Settings {
    readonly title = 'From config';
  }

  @Module({ providers: [Settings], exports: [Settings] })
  class SettingsModule {}

  it('takes its options from a factory with injected providers', async () => {
    const useFactory = vi.fn((settings: Settings) => ({
      logger: { error() {}, warn() {} },
      asyncapi: { title: settings.title },
    }));

    @Module({
      imports: [
        ChanxModule.forRootAsync({
          imports: [SettingsModule],
          inject: [Settings],
          useFactory,
        }),
      ],
      providers: [GreetingService, ChatGateway, RoomTopic],
    })
    class AsyncModule {}

    const app = await NestFactory.create(AsyncModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    const { port } = app.getHttpServer().address() as AddressInfo;

    expect(useFactory).toHaveBeenCalledWith(expect.any(Settings));
    const document = (await (
      await fetch(`http://127.0.0.1:${port}/asyncapi.json`)
    ).json()) as {
      info: { title: string };
    };
    expect(document.info.title).toBe('From config');
    const client = open(`ws://127.0.0.1:${port}/ws/chat/lobby?token=ok`);
    expect(await client.request({ action: 'ping' })).toMatchObject({ action: 'pong' });
    expect(app.get(ChanxService)).toBeInstanceOf(ChanxService);
  });
});

describe('exception filters', () => {
  class OutOfStock extends Error {}
  class Unrelated extends Error {}
  const Order = defineMessage('order', z.object({ item: z.string() }));
  const Sold = defineMessage('sold', z.object({ item: z.string() }));
  const seen: string[] = [];

  @Catch(OutOfStock)
  class OutOfStockFilter implements ExceptionFilter {
    catch(error: OutOfStock, host: ArgumentsHost) {
      const ctx = host.switchToWs().getClient<{ ref?: string }>();
      return ErrorMessage.create({ detail: `${error.message} (${ctx.ref})` });
    }
  }

  @Catch(Unrelated)
  class UnrelatedFilter implements ExceptionFilter {
    catch() {
      return ErrorMessage.create({ detail: 'never' });
    }
  }

  @Catch()
  class Watcher implements ExceptionFilter {
    catch(error: Error, host: ArgumentsHost) {
      seen.push(`${host.getType()}: ${error.message}`);
      throw error;
    }
  }

  @ChanxConsumer('/ws/shop', { name: 'shop' })
  class ShopGateway {
    @On(Order, { output: Sold })
    @UseFilters(OutOfStockFilter)
    order(@Payload('item') item: string) {
      if (item === 'gone') throw new OutOfStock(`${item} is out of stock`);
      if (item === 'broken') throw new ForbiddenException();
      return Sold.create({ item });
    }

    @On(Secret)
    @UseFilters(UnrelatedFilter)
    secret() {
      throw new ForbiddenException();
    }
  }

  async function shop(globalFilter = false) {
    @Module({
      imports: [ChanxModule.forRoot({ logger: { error() {}, warn() {} } })],
      providers: [ShopGateway],
    })
    class ShopModule {}
    const app = await NestFactory.create(ShopModule, { logger: false });
    if (globalFilter) app.useGlobalFilters(new Watcher());
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    const { port } = app.getHttpServer().address() as AddressInfo;
    return open(`ws://127.0.0.1:${port}/ws/shop`);
  }

  it("answers with what a handler's filter returns, as its reply", async () => {
    const client = await shop();
    expect(
      await client.request({ action: 'order', payload: { item: 'gone' } }),
    ).toMatchObject({
      action: 'error',
      payload: { detail: 'gone is out of stock (1)' },
      ref: '1',
    });
  });

  it("leaves what no filter catches to chanx's handling", async () => {
    const client = await shop();
    expect(await client.request({ action: 'secret' })).toMatchObject({
      action: 'error',
      payload: { status_code: 403 },
    });
  });

  it('runs global filters with the ws context type', async () => {
    seen.length = 0;
    const client = await shop(true);
    expect(
      await client.request({ action: 'order', payload: { item: 'broken' } }),
    ).toMatchObject({
      payload: { status_code: 403 },
    });
    expect(seen).toEqual(['ws: Forbidden']);
  });
});

describe("beside Nest's own WebSocket gateways", () => {
  @WebSocketGateway({ path: '/nest' })
  class NestEchoGateway {
    @SubscribeMessage('echo')
    echo(@MessageBody() body: string) {
      return { event: 'echo', data: body };
    }
  }

  @WebSocketGateway()
  class SocketIoEchoGateway {
    @SubscribeMessage('echo')
    echo(@MessageBody() body: string) {
      return body;
    }
  }

  async function serve(gateway: Type, adapter: 'ws' | 'socket.io') {
    @Module({
      imports: [ChanxModule.forRoot({ logger: { error() {}, warn() {} } })],
      providers: [GreetingService, ChatGateway, RoomTopic, gateway],
    })
    class BesideModule {}
    const app = await NestFactory.create(BesideModule, { logger: false });
    app.useWebSocketAdapter(adapter === 'ws' ? new WsAdapter(app) : new IoAdapter(app));
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    const { port } = app.getHttpServer().address() as AddressInfo;
    return port;
  }

  it('serves chanx and a @WebSocketGateway on WsAdapter, on one server', async () => {
    const port = await serve(NestEchoGateway, 'ws');

    const chanx = open(`ws://127.0.0.1:${port}/ws/chat/lobby?token=ok`);
    expect(await chanx.request({ action: 'ping' })).toMatchObject({ action: 'pong' });

    const nest = new WebSocket(`ws://127.0.0.1:${port}/nest`);
    const reply = new Promise<string>((resolve) =>
      nest.on('message', (data) => resolve(data.toString())),
    );
    await new Promise((resolve) => nest.once('open', resolve));
    nest.send(JSON.stringify({ event: 'echo', data: 'hi' }));
    expect(JSON.parse(await reply)).toEqual({ event: 'echo', data: 'hi' });
    nest.close();
  });

  it('serves chanx and a Socket.IO @WebSocketGateway, on one server', async () => {
    const port = await serve(SocketIoEchoGateway, 'socket.io');

    const chanx = open(`ws://127.0.0.1:${port}/ws/chat/lobby?token=ok`);
    expect(await chanx.request({ action: 'ping' })).toMatchObject({ action: 'pong' });

    const io = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    try {
      expect(await io.timeout(2000).emitWithAck('echo', 'hi')).toBe('hi');
    } finally {
      io.close();
    }
  });
});
