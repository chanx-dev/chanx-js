// Compiled with experimentalDecorators, as NestJS projects are.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AsyncJsonWebsocketConsumer,
  Consumer,
  On,
  OnEvent,
  PingMessage,
  PongMessage,
  createChanx,
  defineMessage,
} from '../../src';
import { connect } from '../../src/testing';

const Count = defineMessage('count');
const Counted = defineMessage('counted', z.object({ n: z.number() }));
const Alert = defineMessage('alert', z.object({ level: z.string() }));

abstract class Base extends AsyncJsonWebsocketConsumer {
  @On(PingMessage, { output: PongMessage })
  ping() {
    return PongMessage.create();
  }
}

@Consumer('/ws', { name: 'legacy', groups: ['all'] })
class LegacyConsumer extends Base {
  private n = 0;

  @On(Count, { output: Counted })
  count() {
    return Counted.create({ n: ++this.n });
  }

  @OnEvent(Alert, { output: Alert })
  alert(e: { action: 'alert'; payload: { level: string } }) {
    return Alert.create({ level: e.payload.level.toUpperCase() });
  }
}

describe('legacy decorators', () => {
  it('check method signatures too', () => {
    abstract class Checked extends AsyncJsonWebsocketConsumer {
      // @ts-expect-error: the parameter does not match the message
      @On(Alert) wrongParam(m: { payload: { level: number } }) {
        void m;
      }

      // @ts-expect-error: the reply is not the declared output
      @On(Count, { output: Counted }) wrongReply() {
        return PongMessage.create();
      }
    }
    expect(Checked).toBeDefined();
  });

  it('are what this file compiles to', () => {
    let received = 0;
    const probe = (...args: unknown[]) => void (received = args.length);
    class Probed {
      @probe
      method() {}
    }
    void Probed;
    // Legacy method decorators get (target, key, descriptor); standard ones (value, context).
    expect(received).toBe(3);
  });

  it('declare handlers, inherited ones included, and events', async () => {
    const chanx = createChanx({ consumers: [LegacyConsumer] });
    const client = connect(chanx, '/ws');
    await client.ready;

    expect((await client.request({ action: 'ping' })).action).toBe('pong');
    expect((await client.request({ action: 'count' })).payload).toEqual({ n: 1 });
    await chanx.broadcastEvent(LegacyConsumer, Alert.create({ level: 'high' }));
    expect(await client.receive()).toEqual({
      action: 'alert',
      payload: { level: 'HIGH' },
    });
  });
});
