# NestJS

`@chanx-js/nestjs` serves consumers and topics as injectable gateways: they get Nest's
dependency injection, guards, interceptors, pipes and exception filters, and speak chanx's protocol.

::: code-group

```bash [pnpm]
pnpm add @chanx-js/nestjs @chanx-js/server ws zod
```

```bash [npm]
npm install @chanx-js/nestjs @chanx-js/server ws zod
```

:::

## A gateway

```ts
import { Injectable, Module, UseGuards } from '@nestjs/common';
import type { ConnectRequest, Context } from '@chanx-js/server';
import { PingMessage, PongMessage } from '@chanx-js/server';
import { ChanxConsumer, ChanxModule, Ctx, On, Payload } from '@chanx-js/nestjs';

@ChanxConsumer('/ws/chat/{room}', { name: 'chat', emits: [Notice] })
export class ChatGateway {
  constructor(private readonly users: UsersService) {}

  authenticate({ url }: ConnectRequest) {
    return this.users.fromToken(url.searchParams.get('token'));
  }

  @On(PingMessage, { output: PongMessage })
  ping() {
    return PongMessage.create();
  }

  @On(Chat, { output: Notice })
  @UseGuards(MemberGuard)
  chat(
    @Payload('text') text: string,
    @Ctx() ctx: Context<'/ws/chat/{room}', unknown, User, never>,
  ) {
    return Notice.create({ text: `${ctx.params.room}: ${text}` });
  }
}

@Module({
  imports: [ChanxModule.forRoot()],
  providers: [UsersService, ChatGateway],
})
export class AppModule {}
```

`ChanxModule` finds every `@ChanxConsumer` and `@ChanxTopic` provider when the app
starts, and serves them on the app's HTTP server, on Express or Fastify. `forRoot()`
takes `createChanx`'s options (`layers`, `camelize`, ...) plus `pingInterval`, and
`asyncapi` to serve the [AsyncAPI](/server/asyncapi) docs page and document:

````ts
ChanxModule.forRoot({ asyncapi: { title: 'Chat API' } }); // /asyncapi, .json, .yaml
``` Nest needs
`emitDecoratorMetadata`, as any Nest app does.

## Options from providers

`forRootAsync` takes its options from a factory, as `TypeOrmModule` and others do, so
layers and AsyncAPI settings can come from `ConfigService`:

```ts
ChanxModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    layers: { default: new RedisPubSubChannelLayer({ hosts: [config.get('REDIS_URL')] }) },
    asyncapi: { title: config.get('API_TITLE') },
  }),
});
```

`useClass` and `useExisting` work as in any Nest module.

## DTOs as message schemas

`dtoSchema` turns a class-validator DTO into a message schema. The payload arrives as a
DTO instance, validated; a failure reaches the client in chanx's error shape, with the
constraint's message at the property's path.

```ts
import { dtoSchema } from '@chanx-js/nestjs';

class ChatPayload {
  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MaxLength(500)
  text!: string;
}

const Chat = defineMessage('chat', dtoSchema(ChatPayload));
```

AsyncAPI documents the DTO under its class name, as pydantic models are, with nested
DTOs as components of their own. The schema comes from `@nestjs/swagger` when the DTO
has `@ApiProperty` decorators, else from `class-validator-jsonschema` when it is
installed, else the payload is documented as any object. A second argument passes
class-validator's options: `dtoSchema(ChatPayload, { whitelist: true })`.

## Handlers

- `@Payload()` is the message's payload; `@Payload('text')` one property of it.
  Pipes work as usual. Prefer `dtoSchema` to `@Payload(new ValidationPipe())`: the
  message's schema then validates every handler and documents AsyncAPI as well.
- `@Ctx()` is the chanx context: `send`, `broadcast`, `params`, `conn` and the rest.
- `@MessageBody()` and `@ConnectedSocket()` from `@nestjs/websockets` work too.
- `@OnEvent(Message)` handles events from the channel layer.
- Operations in AsyncAPI are named after the methods.

## Guards, interceptors and errors

Guards, interceptors and pipes run as for a Nest WebSocket gateway. A guard sees the
chanx context as the client: `context.switchToWs().getClient()`.

An `HttpException` or `WsException` thrown by a handler, guard or pipe reaches the
client as an `error` frame with its detail. Anything else is logged, and the client
gets chanx's generic error.

Exception filters run first: `@UseFilters` on a handler or gateway, and global filters.
What a filter returns is sent as the reply; the chanx context is its client:

```ts
@Catch(OutOfStock)
export class OutOfStockFilter implements ExceptionFilter {
  catch(error: OutOfStock, host: ArgumentsHost) {
    return ErrorMessage.create({ detail: error.message });
  }
}
```

A filter that rethrows, or none that matches, leaves the error to the handling above.
Global filters see the `ws` context type, so an HTTP-only one should check
`host.getType()`. Nest's `BaseWsExceptionFilter` does not fit: it emits Socket.IO style
events, which a chanx client does not read.

## Hooks

Hooks are plain methods on the gateway:

- Consumers: `authenticate`, `onConnect`, `onDisconnect`.
- Topics: `authorize`, `onSubscribe`, `onUnsubscribe`.
- Both: `onValidationError`, `onHandlerError`, `onEventError`.

## Topics

```ts
@ChanxTopic('room:{room_name}', { passthrough: [RoomEvent] })
export class RoomTopic {
  authorize({ params }: { params: Record<string, string> }) {
    return params.room_name !== 'secret';
  }

  @On(Post, { output: Posted })
  async post(
    @Payload() payload: { body: string },
    @Ctx() ctx: TopicContext<'room:{room_name}', unknown, never>,
  ) {
    await ctx.publish(RoomEvent.create(payload));
    return Posted.create(payload);
  }
}
````

Mount it in a consumer's options: `@ChanxConsumer('/ws/hub', { name: 'hub', topics: [RoomTopic] })`.

## AsyncAPI in CI

`chanx-nestjs asyncapi` writes the document from the compiled module, without serving
it, to commit it or hand it to [`@chanx-js/codegen`](/client/codegen):

```bash
npx chanx-nestjs asyncapi dist/app.module.js -o asyncapi.json --title "Chat API"
```

It boots the module as an application context, with no HTTP server: providers still
start, so a database module connects as at startup. `--module` names another export,
and an `-o` ending in `.yaml` writes YAML (with the `yaml` package). In code,
`asyncapiOf(AppModule, options)` returns the same document.

## Beside Nest's gateways

Nest's own `@WebSocketGateway` classes work on the same server, on `WsAdapter` or
Socket.IO: each gets the paths chanx does not serve.

## From services

Inject `ChanxService` to reach connections from anywhere in the app:

```ts
@Injectable()
export class RoomsService {
  constructor(private readonly chanx: ChanxService) {}

  announce(user: string) {
    return this.chanx.broadcastEvent(ChatGateway, UserJoined.create({ user }));
  }
}
```

It also has `sendEvent`, `publish` (to a topic) and `asyncapi()`.

## Scope

A singleton gateway serves every connection, and its fields are shared by them all.

A request-scoped gateway, or one that injects a request-scoped provider, gets an
instance per connection: its fields are that connection's state, kept for every message
on it. The connection is Nest's `REQUEST`, so request-scoped services can inject it:

```ts
@Injectable({ scope: Scope.REQUEST })
export class Session {
  constructor(@Inject(REQUEST) readonly conn: Connection) {}
}

@ChanxConsumer('/ws/chat/{room}', { name: 'chat' })
export class ChatGateway {
  constructor(private readonly session: Session) {}
}
```

A request-scoped topic gets an instance, and request-scoped providers of its own, per
subscription. Transient gateways are refused at startup.
