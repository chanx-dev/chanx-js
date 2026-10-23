import { describe, expect, it } from 'vitest';

import {
  formatPattern,
  parsePattern,
  patternParams,
  safeGroupName,
  stripEnvelope,
  withEnvelope,
} from '../src';

// Expected values are chanx's own output (2.11.7), so Python and Node share group names.
describe('safeGroupName', () => {
  it.each([
    [['user', 42], 'notification', 'notification.user.42'],
    [['room', 'Weekly Sync!'], undefined, 'room.Weekly-Sync'],
    [['discussion:5'], 'DiscussionTopic', 'DiscussionTopic.discussion-5'],
    [['--a--', '', 'b'], undefined, 'a.b'],
    [['café ☕ room'], undefined, 'caf-room'],
    [['a'.repeat(99)], undefined, 'a'.repeat(99)],
  ])('%j in %s gives %s', (parts, namespace, expected) => {
    expect(safeGroupName(parts, { namespace })).toBe(expected);
  });

  it.each([
    [['a'.repeat(100)], undefined, `${'a'.repeat(86)}.aa3918874ba9`],
    [['x'.repeat(120)], undefined, `${'x'.repeat(86)}.8d7dc2472c3f`],
    [
      [`room:${'a'.repeat(95)}`],
      'RoomTopic',
      `RoomTopic.room-${'a'.repeat(71)}.17bcc143ceaf`,
    ],
  ])('digests an over-long name like chanx', (parts, namespace, expected) => {
    expect(safeGroupName(parts, { namespace })).toBe(expected);
  });

  it('rejects a name with nothing left', () => {
    expect(() => safeGroupName(['!!!'])).toThrow('empty name');
  });
});

describe('parsePattern', () => {
  it.each([
    ['room:{room_name}', 'room:lobby', { room_name: 'lobby' }],
    ['run:{id}:step:{step}', 'run:7:step:3', { id: '7', step: '3' }],
    ['a.b+{x}', 'a.b+1', { x: '1' }],
    ['static', 'static', {}],
  ])('%s matches %s', (pattern, value, expected) => {
    expect(parsePattern(pattern)(value)).toEqual(expected);
  });

  it.each([
    ['room:{room_name}', 'room:a:b'],
    ['run:{id}:step:{step}', 'run:7:step:'],
    ['a.b+{x}', 'aXb+1'],
    ['static', 'static2'],
  ])('%s rejects %s', (pattern, value) => {
    expect(parsePattern(pattern)(value)).toBeNull();
  });

  it('round-trips with formatPattern', () => {
    const pattern = 'run:{id}:step:{step}';
    expect(parsePattern(pattern)(formatPattern(pattern, { id: 7, step: 'b' }))).toEqual({
      id: '7',
      step: 'b',
    });
  });
});

describe('formatPattern', () => {
  it('encodes values only when asked', () => {
    expect(formatPattern('/ws/{room}/', { room: 'a/b' }, encodeURIComponent)).toBe(
      '/ws/a%2Fb/',
    );
    expect(formatPattern('room:{room}', { room: 'a/b' })).toBe('room:a/b');
  });

  it('lists params in order', () => {
    expect(patternParams('run:{id}:step:{step}')).toEqual(['id', 'step']);
  });
});

describe('envelope', () => {
  it('stamps only the envelope keys it is given', () => {
    const frame = withEnvelope(
      { action: 'room_event', payload: 1, topic: 'stray' },
      { topic: 'room:lobby', seq: 3 },
    );
    expect(frame).toEqual({
      version: 1,
      topic: 'room:lobby',
      seq: 3,
      action: 'room_event',
      payload: 1,
    });
    expect(stripEnvelope(frame as never)).toEqual({ action: 'room_event', payload: 1 });
  });
});
