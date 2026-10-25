import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ClassContext } from '../src';
import {
  AsyncJsonWebsocketConsumer,
  Consumer,
  On,
  OnEvent,
  PingMessage,
  PongMessage,
  createChanx,
  defineMessage,
} from '../src';
import { connect } from '../src/testing';

const Count = defineMessage('count');
const Counted = defineMessage('counted', z.object({ n: z.number(), room: z.string() }));
const Echo = defineMessage('echo', z.object({ text: z.string() }));
const Echoed = defineMessage('echoed', z.object({ text: z.string() }));
const Alert = defineMessage('alert', z.object({ level: z.string() }));
const AlertNotice = defineMessage('alert_notice', z.object({ level: z.string() }));
const WhoIs = defineMessage('who_is');
const Here = defineMessage('here', z.object({ who: z.string() }));

const events: string[] = [];

abstract class AppConsumer extends AsyncJsonWebsocketConsumer<{ name: string }> {
  protected get who() {
    return this.conn.user.name;
  }

  override onConnect() {
    events.push(`connect ${this.who}`);
  }

  override onDisconnect() {
    events.push(`disconnect ${this.who}`);
  }

  @On(PingMessage, { output: PongMessage })
  ping() {
    return PongMessage.create();
  }
}

type Constructor<T> = abstract new (...args: any[]) => T;

function WithPresence<B extends Constructor<AppConsumer>>(Base: B) {
  abstract class Presence extends Base {
    @On(WhoIs, { output: Here })
    whoIs() {
      return Here.create({ who: this.who });
    }
  }
  return Presence;
}

@Consumer('/ws/room/{room}', {
  name: 'room',
  authenticate: ({ url }) => ({ name: url.searchParams.get('as') ?? 'anon' }),
  groups: ['rooms'],
  passthrough: [Alert],
})
class RoomConsumer extends WithPresence(AppConsumer) {
  private n = 0;
  private readonly room = this.params.room!;

  @On(Count, { output: Counted })
  count() {
    return Counted.create({ n: ++this.n, room: this.room });
  }

  @On(Echo)
  async echo(m: { payload: { text: string } }, ctx: ClassContext) {
    await this.push(Echoed.create({ text: 'pushed' }));
    await ctx.send(Echoed.create(m.payload));
  }
}

const app = () => createChanx({ consumers: [RoomConsumer] });

async function joined(url: string) {
  const client = connect(app(), url);
  await client.ready;
  await client.receive(); // authentication
  return client;
}

describe('class consumers', () => {
  it('handle messages through decorated methods, replying with the ref', async () => {
    const client = await joined('/ws/room/lobby');
    expect(await client.request({ action: 'ping' })).toEqual({
      action: 'pong',
      payload: null,
      version: 1,
      ref: 'test-1',
    });
  });

  it('get an instance per connection, so fields are per-connection state', async () => {
    const chanx = app();
    const ann = connect(chanx, '/ws/room/lobby?as=ann');
    const bob = connect(chanx, '/ws/room/hall?as=bob');
    await Promise.all([ann.ready, bob.ready]);
    await Promise.all([ann.receive(), bob.receive()]);

    ann.send({ action: 'count' });
    ann.send({ action: 'count' });
    bob.send({ action: 'count' });

    expect((await ann.receive()).payload).toEqual({ n: 1, room: 'lobby' });
    expect((await ann.receive()).payload).toEqual({ n: 2, room: 'lobby' });
    expect((await bob.receive()).payload).toEqual({ n: 1, room: 'hall' });
  });

  it('push through the instance and reply through the context', async () => {
    const client = await joined('/ws/room/lobby');
    client.send({ action: 'echo', payload: { text: 'hi' }, version: 1, ref: 'r' });

    expect(await client.receive()).toEqual({
      action: 'echoed',
      payload: { text: 'pushed' },
    });
    expect(await client.receive()).toMatchObject({ payload: { text: 'hi' }, ref: 'r' });
  });

  it('take handlers from base classes and mixins', async () => {
    const client = await joined('/ws/room/lobby?as=ann');
    expect((await client.request({ action: 'who_is' })).payload).toEqual({ who: 'ann' });
  });

  it('run the hooks a base class overrides', async () => {
    events.length = 0;
    const client = await joined('/ws/room/lobby?as=cat');
    await client.close();
    expect(events).toEqual(['connect cat', 'disconnect cat']);
  });

  it('handle events and passthrough events', async () => {
    const chanx = app();
    const client = connect(chanx, '/ws/room/lobby');
    await client.ready;
    await client.receive();

    await chanx.broadcastEvent(RoomConsumer, Alert.create({ level: 'high' }));

    expect(await client.receive()).toEqual({
      action: 'alert',
      payload: { level: 'high' },
    });
  });
});

describe('class handler rules, as chanx', () => {
  it('lets an override replace a handler, and an undecorated override remove it', async () => {
    abstract class Base extends AsyncJsonWebsocketConsumer {
      @On(Echo, { output: Echoed })
      echo() {
        return Echoed.create({ text: 'base' });
      }

      @On(PingMessage, { output: PongMessage })
      ping() {
        return PongMessage.create();
      }
    }
    @Consumer('/ws', { name: 'child' })
    class Child extends Base {
      @On(Echo, { output: Echoed })
      override echo() {
        return Echoed.create({ text: 'child' });
      }

      override ping() {
        return PongMessage.create();
      }
    }
    const client = connect(
      createChanx({ consumers: [Child], logger: { error() {}, warn() {} } }),
      '/ws',
    );

    expect(
      (await client.request({ action: 'echo', payload: { text: '' } })).payload,
    ).toEqual({
      text: 'child',
    });
    expect((await client.request({ action: 'ping' })).action).toBe('error');
  });

  it('rejects two methods handling one action', () => {
    expect(() => {
      @Consumer('/ws', { name: 'twice' })
      class Twice extends AsyncJsonWebsocketConsumer {
        @On(PingMessage)
        first() {}

        @On(PingMessage)
        second() {}
      }
      void Twice;
    }).toThrow('Twice has two message handlers for action "ping": first() and second()');
  });

  it('allows a message handler and an event handler for the same action', () => {
    expect(() => {
      @Consumer('/ws', { name: 'both' })
      class Both extends AsyncJsonWebsocketConsumer {
        @On(Alert)
        message() {}

        @OnEvent(Alert, { output: AlertNotice })
        event(e: { payload: { level: string } }) {
          return AlertNotice.create(e.payload);
        }
      }
      void Both;
    }).not.toThrow();
  });

  it('refuses a class that is not a consumer', () => {
    class Plain extends AsyncJsonWebsocketConsumer {}
    expect(() => createChanx({ consumers: [Plain] })).toThrow('Not a consumer');
  });

  it('closes with 1011 when the instance cannot be built', async () => {
    @Consumer('/ws', { name: 'broken' })
    class Broken extends AsyncJsonWebsocketConsumer {
      readonly db = (() => {
        throw new Error('no database');
      })();
    }
    const logger = { error: vi.fn(), warn: vi.fn() };
    const client = connect(createChanx({ consumers: [Broken], logger }), '/ws');
    expect((await client.closed).code).toBe(1011);
  });
});

describe('class handler types', () => {
  it('checks method signatures against the decorator', () => {
    abstract class Checked extends AsyncJsonWebsocketConsumer {
      // @ts-expect-error: the parameter does not match the message
      @On(Echo) wrongParam(m: { payload: { text: number } }) {
        void m;
      }

      // @ts-expect-error: the reply is not the declared output
      @On(Count, { output: Counted }) wrongReply() {
        return PongMessage.create();
      }
    }
    expect(Checked).toBeDefined();
  });
});

describe('Class consumers broadcasting', () => {
  const Shout = defineMessage('shout', z.object({ text: z.string() }));
  const Heard = defineMessage('heard', z.object({ text: z.string() }));

  @Consumer('/ws/room/{name}', { name: 'room', emits: [Heard], groups: ['room'] })
  class RoomConsumer extends AsyncJsonWebsocketConsumer {
    @On(Shout)
    async shout(m: { payload: { text: string } }) {
      await this.broadcast(Heard.create(m.payload), { excludeCurrent: true });
    }
  }

  it('reach the other connections in their groups, not themselves when asked', async () => {
    const chanx = createChanx({ consumers: [RoomConsumer] });
    const ann = connect(chanx, '/ws/room/a');
    const bob = connect(chanx, '/ws/room/a');
    await Promise.all([ann.ready, bob.ready]);

    await ann.sendMessage(Shout.create({ text: 'hi' }));

    expect(await bob.receive()).toEqual({ action: 'heard', payload: { text: 'hi' } });
    expect(await ann.receiveNothing()).toBe(true);
  });
});
