import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ClassContext, Message, TopicClassContext, ValidationIssue } from '../src';
import {
  AsyncJsonWebsocketConsumer,
  Consumer,
  On,
  OnEvent,
  Topic,
  consumer,
  createChanx,
  defineMessage,
  topic,
} from '../src';
import { connect } from '../src/testing';

const Say = defineMessage('say', z.object({ text: z.string() }));
const Boom = defineMessage('boom');
const Alert = defineMessage('alert');
const Problem = defineMessage(
  'problem',
  z.object({ kind: z.string(), detail: z.string() }),
);

const fails = () => {
  throw new Error('kaput');
};

describe('error hooks on consumer()', () => {
  const logger = { error: vi.fn(), warn: vi.fn() };
  const custom = consumer('/ws', {
    name: 'custom',
    emits: [Problem],
    groups: ['all'],
    onValidationError: (issues, ctx) =>
      ctx.send(
        Problem.create({
          kind: 'invalid',
          detail: issues.map((i) => i.loc.join('.')).join(),
        }),
      ),
    onHandlerError: (error, message, ctx) =>
      ctx.send(
        Problem.create({ kind: message.action, detail: (error as Error).message }),
      ),
    onEventError: (error, event, ctx) =>
      ctx.push(
        Problem.create({
          kind: `event ${event.action}`,
          detail: (error as Error).message,
        }),
      ),
  })
    .on(Say, () => {})
    .on(Boom, fails)
    .event(Alert, fails);
  const chanx = createChanx({ consumers: [custom], logger });

  it('answers a frame that failed validation as the hook says', async () => {
    const client = connect(chanx, '/ws');
    expect(await client.request({ action: 'say' })).toMatchObject({
      action: 'problem',
      payload: { kind: 'invalid', detail: 'say.payload' },
      ref: 'test-1',
    });
  });

  it('reports a failing handler as the hook says, with the ref', async () => {
    const client = connect(chanx, '/ws');
    expect(await client.request({ action: 'boom' })).toMatchObject({
      payload: { kind: 'boom', detail: 'kaput' },
      ref: 'test-1',
    });
  });

  it('reports a failing event handler as the hook says', async () => {
    const client = connect(chanx, '/ws');
    await client.ready;
    await chanx.broadcastEvent(custom, Alert.create());
    expect((await client.receive()).payload).toEqual({
      kind: 'event alert',
      detail: 'kaput',
    });
  });

  it('logs a hook that throws, and keeps the connection', async () => {
    const throwing = createChanx({
      logger,
      consumers: [
        consumer('/ws', { name: 't', onHandlerError: fails })
          .on(Boom, fails)
          .on(Say, () => {}),
      ],
    });
    const client = connect(throwing, '/ws');
    client.send({ action: 'boom' });

    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        'chanx: error hook failed',
        expect.any(Error),
      ),
    );
    client.send({ action: 'say', payload: { text: 5 } });
    expect((await client.receive()).action).toBe('error');
  });
});

describe('error hooks on topic()', () => {
  it('handle the topic own failures', async () => {
    const room = topic('room:{id}', {
      onHandlerError: (error, message, ctx) =>
        ctx.send({
          action: 'problem',
          payload: { kind: `${ctx.topic} ${message.action}`, detail: String(error) },
        }),
    }).on(Boom, fails);
    const client = connect(
      createChanx({ consumers: [consumer('/ws', { name: 'h', topics: [room] })] }),
      '/ws',
    );
    await client.ready;
    await client.request({ action: 'subscribe' }, { topic: 'room:1' });

    expect(await client.request({ action: 'boom' }, { topic: 'room:1' })).toMatchObject({
      payload: { kind: 'room:1 boom', detail: 'Error: kaput' },
      topic: 'room:1',
    });
  });
});

describe('error hooks on classes', () => {
  @Consumer('/ws', { name: 'classy', groups: ['all'] })
  class Classy extends AsyncJsonWebsocketConsumer {
    private failures = 0;

    @On(Boom)
    boom() {
      fails();
    }

    @OnEvent(Alert)
    alert() {
      fails();
    }

    override onHandlerError(_error: unknown, message: Message, ctx: ClassContext) {
      return ctx.send(
        Problem.create({ kind: message.action, detail: `failure ${++this.failures}` }),
      );
    }

    override onValidationError(issues: ValidationIssue[], ctx: ClassContext) {
      return ctx.send(Problem.create({ kind: 'invalid', detail: String(issues.length) }));
    }
  }

  it('call the overriding method on the instance serving the connection', async () => {
    const client = connect(createChanx({ consumers: [Classy] }), '/ws');
    expect((await client.request({ action: 'boom' })).payload).toEqual({
      kind: 'boom',
      detail: 'failure 1',
    });
    expect((await client.request({ action: 'boom' })).payload).toEqual({
      kind: 'boom',
      detail: 'failure 2',
    });
    expect((await client.request({ action: 'nope' })).payload).toEqual({
      kind: 'invalid',
      detail: '1',
    });
  });

  it('keep the default for a hook the class does not override', async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const chanx = createChanx({ consumers: [Classy], logger });
    const client = connect(chanx, '/ws');
    await client.ready;

    await chanx.broadcastEvent(Classy, Alert.create(), ['all']);

    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        'chanx: event handler for "alert" failed',
        expect.any(Error),
      ),
    );
    expect(client.pending).toEqual([]);
  });

  it('work on Topic classes', async () => {
    class Room extends Topic {
      static override pattern = 'room:{id}';

      @On(Boom)
      boom() {
        fails();
      }

      override onHandlerError(
        _error: unknown,
        _message: Message,
        ctx: TopicClassContext,
      ) {
        return ctx.send({
          action: 'problem',
          payload: { kind: this.topic, detail: 'from the topic' },
        });
      }
    }
    const client = connect(
      createChanx({ consumers: [consumer('/ws', { name: 'h', topics: [Room] })] }),
      '/ws',
    );
    await client.ready;
    await client.request({ action: 'subscribe' }, { topic: 'room:7' });

    expect(
      (await client.request({ action: 'boom' }, { topic: 'room:7' })).payload,
    ).toEqual({
      kind: 'room:7',
      detail: 'from the topic',
    });
  });
});
