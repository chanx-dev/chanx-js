import { describe, expect, it } from 'vitest';

import { PingMessage, PongMessage, consumer, defineMessage, handlers } from '../src';
import { definitionOf } from '../src/consumer';

const Echo = defineMessage('echo');

describe('consumer builder', () => {
  it('rejects two handlers for one action, as chanx does', () => {
    const chat = consumer('/ws/chat', { name: 'chat' }).on(PingMessage, () => {});
    expect(() => chat.on(PingMessage, () => {})).toThrow(
      'Consumer "chat" has two message handlers for action "ping"',
    );
  });

  it('rejects a set that brings an action the consumer already handles', () => {
    const set = handlers().on(PingMessage, () => {});
    const chat = consumer('/ws/chat', { name: 'chat' }).on(PingMessage, () => {});
    expect(() => chat.use(set)).toThrow('two message handlers for action "ping"');
  });

  it('allows a message handler and an event handler for the same action', () => {
    expect(() =>
      consumer('/ws/chat', { name: 'chat' })
        .on(PingMessage, () => {})
        .event(PingMessage, () => {}),
    ).not.toThrow();
  });

  it('never changes a builder another one was derived from', () => {
    const base = consumer('/ws/chat', { name: 'chat' }).on(PingMessage, () => {});
    base.on(Echo, () => {});
    expect([...definitionOf(base).handlers.keys()]).toEqual(['ping']);
  });

  it('merges a set with its outputs and passthrough events', () => {
    const set = handlers()
      .on(PingMessage, { output: PongMessage, summary: 'Ping' }, () =>
        PongMessage.create(),
      )
      .passthrough(Echo);
    const definition = definitionOf(consumer('/ws/chat', { name: 'chat' }).use(set));

    expect(definition.handlers.get('ping')).toMatchObject({
      outputs: [PongMessage],
      summary: 'Ping',
    });
    expect(definition.passthrough).toEqual([Echo]);
  });
});
