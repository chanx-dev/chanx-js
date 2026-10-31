import { describe, expect, it } from 'vitest';

import { instancePath, jsonPointer } from '../src';

describe('jsonPointer', () => {
  it('escapes ~ and / in each segment', () => {
    expect(jsonPointer([])).toBe('');
    expect(jsonPointer(['payload', 'items', 0, 'a/b~c'])).toBe(
      '/payload/items/0/a~1b~0c',
    );
  });
});

// The same cases as chanx's tests/core/test_errors.py and chanx-go's protocol tests.
describe('instancePath', () => {
  it.each([
    [
      ['echo', 'payload', 'text'],
      { payload: { text: 1 } },
      { path: ['payload', 'text'] },
    ],
    [
      ['echo', 'payload', 'text'],
      { payload: {} },
      { path: ['payload'], missing: 'text' },
    ],
    [['v', 'int'], { v: [] }, { path: ['v'] }],
    [['s', 'Circle', 'r'], { s: { r: 'x' } }, { path: ['s', 'r'] }],
    [['s', 'Square', 'side'], { s: { r: 'x' } }, { path: ['s'], missing: 'side' }],
    [['scores', 'a', '[key]'], { scores: { a: 1 } }, { path: ['scores', 'a'] }],
    [['items', 1, 'n'], { items: [{}, { n: 'x' }] }, { path: ['items', 1, 'n'] }],
  ])('follows %j through the data', (loc, data, expected) => {
    expect(instancePath(loc, data)).toEqual(expected);
  });
});
