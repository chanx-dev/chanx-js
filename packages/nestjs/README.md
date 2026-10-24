# @chanx-js/nestjs

chanx for NestJS: consumers and topics as injectable gateways, with Nest's guards,
interceptors, pipes and exception filters. Built on `@chanx-js/server`, so clients
cannot tell it from Python's [chanx](https://github.com/huynguyengl99/chanx).

```ts
import { Module, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { ConnectRequest, Context } from '@chanx-js/server';
import { PingMessage, PongMessage, defineMessage } from '@chanx-js/server';
import { ChanxConsumer, ChanxModule, Ctx, On, Payload } from '@chanx-js/nestjs';

const Chat = defineMessage('chat', z.object({ text: z.string() }));
const Notice = defineMessage('notice', z.object({ text: z.string() }));

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
starts and serves them on the app's HTTP server. Run Nest with
`emitDecoratorMetadata`, as any Nest app does.

- **Handlers** take `@Payload()` (or a property, or pipes: `@Payload(new ValidationPipe())`)
  and `@Ctx()`, the chanx context. `@MessageBody()` and `@ConnectedSocket()` from
  `@nestjs/websockets` work too.
- **Guards, interceptors and pipes** run as for a Nest WebSocket gateway; a guard sees the
  chanx context as the client.
- **Errors:** exception filters run first, and what one returns is the reply. Otherwise
  an `HttpException` or `WsException` thrown by a handler, guard or pipe is sent as an
  `error` frame, and anything else is logged and sent as chanx's generic error.
- **DTOs:** `defineMessage('chat', dtoSchema(ChatPayload))` validates payloads with
  class-validator and documents them in AsyncAPI from `@ApiProperty` or
  `class-validator-jsonschema`.
- **Hooks** are plain methods: `authenticate`, `onConnect`, `onDisconnect` on consumers,
  `authorize`, `onSubscribe`, `onUnsubscribe` on topics, and the error hooks.
- **Scope:** a request-scoped gateway gets an instance per connection (a topic, per
  subscription), with the connection as Nest's `REQUEST`.
- **AsyncAPI in CI:** `npx chanx-nestjs asyncapi dist/app.module.js -o asyncapi.json`
  writes the document without serving it; `asyncapiOf(AppModule)` returns it in code.
- **From services**, inject `ChanxService` to `broadcastEvent`, `sendEvent`, `publish`
  to a topic, or get the `asyncapi()` document.

`ChanxModule.forRoot()` takes `createChanx`'s options (`layers`, `camelize`, ...) plus
`pingInterval`, and `asyncapi: true` (or its options) to serve the AsyncAPI docs page at
`/asyncapi` and the document at `/asyncapi.json` and `/asyncapi.yaml`.
`forRootAsync({ useFactory, inject })` takes them from other providers, such as
`ConfigService`.
