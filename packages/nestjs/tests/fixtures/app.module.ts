import { Module } from '@nestjs/common';
import { PingMessage, PongMessage } from '@chanx-js/server';

import { ChanxConsumer, ChanxModule, On } from '../../src';

@ChanxConsumer('/ws/ping', { name: 'ping' })
class PingGateway {
  @On(PingMessage, { output: PongMessage })
  ping() {
    return PongMessage.create();
  }
}

@Module({
  imports: [ChanxModule.forRoot({ logger: { error() {}, warn() {} } })],
  providers: [PingGateway],
})
export class AppModule {}

@Module({ imports: [AppModule] })
export class OtherModule {}
