import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PingMessage, defineMessage } from '../src';
import { createValidator, envelopeIssues } from '../src/validation';

const Chat = defineMessage('chat', z.object({ message: z.string() }));

// Expected issues are pydantic's, and errors chanx's standard ones, from validating the
// same frames with chanx.
describe('a consumer with several handlers', () => {
  const validate = createValidator([PingMessage, Chat]);

  it.each([
    [
      'an unknown action',
      { action: 'nope' },
      [
        {
          type: 'union_tag_invalid',
          loc: [],
          msg: "Input tag 'nope' found using 'action' does not match any of the expected tags: 'chat', 'ping'",
        },
      ],
      [{ keyword: 'enum', path: ['action'] }],
    ],
    [
      'no action',
      { payload: 1 },
      [
        {
          type: 'union_tag_not_found',
          loc: [],
          msg: "Unable to extract tag using discriminator 'action'",
        },
      ],
      [{ keyword: 'required', path: [], property: 'action' }],
    ],
    [
      'no payload',
      { action: 'chat' },
      [{ type: 'missing', loc: ['chat', 'payload'], msg: 'Field required' }],
      [{ keyword: 'required', path: [], property: 'payload' }],
    ],
    [
      'a payload on a message without one',
      { action: 'ping', payload: 1 },
      [{ type: 'none_required', loc: ['ping', 'payload'], msg: 'Input should be None' }],
      [{ keyword: 'type', path: ['payload'] }],
    ],
  ])('rejects %s', async (_case, frame, issues, errors) => {
    const result = await validate(frame);
    expect(result).toEqual({ issues, errors: issues.map(withDetail(errors)) });
  });

  it('locates payload issues under the action, with the schema library message', async () => {
    const result = await validate({ action: 'chat', payload: { message: 5 } });
    expect(result).toEqual({
      issues: [
        {
          type: 'value_error',
          loc: ['chat', 'payload', 'message'],
          msg: expect.any(String),
        },
      ],
      errors: [
        { keyword: 'type', path: ['payload', 'message'], detail: expect.any(String) },
      ],
    });
  });

  it('accepts a payload-less message without a payload, ignoring extra keys', async () => {
    expect(await validate({ action: 'ping', extra: 1 })).toEqual({
      message: { action: 'ping', payload: null },
    });
  });

  it('hands the handler the schema output', async () => {
    const Count = defineMessage('count', z.object({ n: z.coerce.number() }));
    const result = await createValidator([PingMessage, Count])({
      action: 'count',
      payload: { n: '3' },
    });
    expect(result).toEqual({ message: { action: 'count', payload: { n: 3 } } });
  });
});

// chanx wraps even one message in a discriminated union, so one handler behaves as many.
describe('a consumer with one handler', () => {
  const validate = createValidator([Chat]);

  it.each([
    [
      'an unknown action',
      { action: 'nope' },
      [
        {
          type: 'union_tag_invalid',
          loc: [],
          msg: "Input tag 'nope' found using 'action' does not match any of the expected tags: 'chat'",
        },
      ],
    ],
    [
      'no action',
      { payload: { message: 'x' } },
      [
        {
          type: 'union_tag_not_found',
          loc: [],
          msg: "Unable to extract tag using discriminator 'action'",
        },
      ],
    ],
    [
      'no payload',
      { action: 'chat' },
      [{ type: 'missing', loc: ['chat', 'payload'], msg: 'Field required' }],
    ],
  ])('rejects %s as chanx does', async (_case, frame, issues) => {
    expect(await validate(frame)).toMatchObject({ issues });
  });

  it('locates payload issues under the action', async () => {
    const result = await validate({ action: 'chat', payload: { message: 5 } });
    expect(result).toMatchObject({ issues: [{ loc: ['chat', 'payload', 'message'] }] });
  });
});

// The keyword each Zod issue maps to, and where it points, as chanx reports the same
// failure from Pydantic.
describe('schema library issues in the standard format', () => {
  const Signup = defineMessage(
    'signup',
    z.strictObject({
      username: z.string().min(3).max(8),
      password: z.string().regex(/^[a-z]+$/),
      email: z.email().optional(),
      age: z.number().int().gt(0).lte(150).multipleOf(1).optional(),
      tags: z.array(z.string()).min(1).optional(),
      role: z.enum(['admin', 'user']).optional(),
      profile: z.object({ bio: z.string() }).optional(),
    }),
  );
  const validate = createValidator([PingMessage, Signup]);
  const valid = { username: 'ann', password: 'abc' };

  it.each([
    ['minLength', { ...valid, username: 'al' }, ['payload', 'username']],
    ['maxLength', { ...valid, username: 'a'.repeat(9) }, ['payload', 'username']],
    ['pattern', { ...valid, password: 'ABC' }, ['payload', 'password']],
    ['format', { ...valid, email: 'nope' }, ['payload', 'email']],
    ['exclusiveMinimum', { ...valid, age: 0 }, ['payload', 'age']],
    ['maximum', { ...valid, age: 151 }, ['payload', 'age']],
    ['minItems', { ...valid, tags: [] }, ['payload', 'tags']],
    ['enum', { ...valid, role: 'root' }, ['payload', 'role']],
    ['type', { ...valid, tags: ['a', 1] }, ['payload', 'tags', 1]],
    ['additionalProperties', { ...valid, extra: 1 }, ['payload', 'extra']],
  ])('reports %s', async (keyword, payload, path) => {
    const result = await validate({ action: 'signup', payload });
    expect(result).toMatchObject({ errors: [{ keyword, path }] });
  });

  it('reports a missing member as required, on the object that lacks it', async () => {
    const result = await validate({
      action: 'signup',
      payload: { ...valid, profile: {} },
    });
    expect(result).toMatchObject({
      errors: [{ keyword: 'required', path: ['payload', 'profile'], property: 'bio' }],
    });
  });

  it('reports a refinement as custom', async () => {
    const Even = defineMessage(
      'even',
      z.object({ n: z.number().refine((n) => n % 2 === 0) }),
    );
    const result = await createValidator([Even])({ action: 'even', payload: { n: 1 } });
    expect(result).toMatchObject({
      errors: [{ keyword: 'custom', path: ['payload', 'n'] }],
    });
  });
});

describe('envelope', () => {
  it('accepts a frame with no envelope or a valid one', () => {
    expect(envelopeIssues({ action: 'ping' })).toEqual([]);
    expect(envelopeIssues({ version: 1, ref: 'a', topic: null, seq: 3 })).toEqual([]);
  });

  it('rejects envelope fields of the wrong type, as chanx Envelope does', () => {
    expect(envelopeIssues({ ref: 5, seq: 'x', version: null })).toEqual([
      { type: 'int_type', loc: ['version'], msg: 'Input should be a valid integer' },
      { type: 'string_type', loc: ['ref'], msg: 'Input should be a valid string' },
      {
        type: 'int_parsing',
        loc: ['seq'],
        msg: 'Input should be a valid integer, unable to parse string as an integer',
      },
    ]);
    expect(envelopeIssues([1])).toMatchObject([{ type: 'model_type', loc: [] }]);
  });

  it('reads integers leniently, as pydantic does for chanx Envelope', () => {
    for (const value of ['12', ' 7 ', '+3', '-4', '1_000', '12.0', true, false, 1.0]) {
      expect(envelopeIssues({ version: value, seq: value })).toEqual([]);
    }
    expect(envelopeIssues({ version: 1.5, seq: '1.5' })).toEqual([
      {
        type: 'int_from_float',
        loc: ['version'],
        msg: 'Input should be a valid integer, got a number with a fractional part',
      },
      {
        type: 'int_parsing',
        loc: ['seq'],
        msg: 'Input should be a valid integer, unable to parse string as an integer',
      },
    ]);
    for (const value of ['x', '1.', '', '1 2', '0x1', '1e2']) {
      expect(envelopeIssues({ version: value })).toMatchObject([{ type: 'int_parsing' }]);
    }
  });
});

function withDetail(errors: object[]) {
  return (issue: { msg: string }, index: number) => ({
    ...errors[index],
    detail: issue.msg,
  });
}
