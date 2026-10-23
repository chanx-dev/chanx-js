import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PingMessage, defineMessage } from '../src';
import { createValidator, envelopeIssues } from '../src/validation';

const Chat = defineMessage('chat', z.object({ message: z.string() }));

// Expected issues are pydantic's, from validating the same frames with chanx.
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
          msg: "Input tag 'nope' found using 'action' does not match any of the expected tags: 'ping', 'chat'",
        },
      ],
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
    ],
    [
      'no payload',
      { action: 'chat' },
      [{ type: 'missing', loc: ['chat', 'payload'], msg: 'Field required' }],
    ],
    [
      'a payload on a message without one',
      { action: 'ping', payload: 1 },
      [{ type: 'none_required', loc: ['ping', 'payload'], msg: 'Input should be None' }],
    ],
  ])('rejects %s', async (_case, frame, issues) => {
    expect(await validate(frame)).toEqual({ issues });
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

describe('a consumer with one handler, which pydantic validates as a single model', () => {
  const validate = createValidator([Chat]);

  it('reports a wrong action as a literal error, alongside payload issues', async () => {
    expect(await validate({ action: 'nope' })).toEqual({
      issues: [
        { type: 'literal_error', loc: ['action'], msg: "Input should be 'chat'" },
        { type: 'missing', loc: ['payload'], msg: 'Field required' },
      ],
    });
  });

  it('locates payload issues without the action prefix', async () => {
    const result = await validate({ action: 'chat', payload: { message: 5 } });
    expect(result).toMatchObject({ issues: [{ loc: ['payload', 'message'] }] });
  });

  it('takes a missing action as the default, as the model does', async () => {
    expect(await validate({ payload: { message: 'hi' } })).toEqual({
      message: { action: 'chat', payload: { message: 'hi' } },
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
      { type: 'int_type', loc: ['seq'], msg: 'Input should be a valid integer' },
    ]);
    expect(envelopeIssues([1])).toMatchObject([{ type: 'model_type', loc: [] }]);
  });
});
