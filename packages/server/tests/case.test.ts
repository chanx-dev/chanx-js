import { describe, expect, it } from 'vitest';

import { camelize, decamelize } from '../src/case';

// Expected values are pyhumps' own output, which chanx uses.
describe('camelize', () => {
  it.each([
    ['snake_case', 'snakeCase'],
    ['a_b_c', 'aBC'],
    ['_leading', '_leading'],
    ['__dunder__', '__dunder__'],
    ['with_2_numbers', 'with2Numbers'],
    ['HTTPResponse', 'HTTPResponse'],
    ['getHTTPResponseCode', 'getHTTPResponseCode'],
    ['a__b', 'aB'],
    ['trailing_', 'trailing_'],
    ['ID', 'ID'],
    ['user_id', 'userId'],
  ])('%s -> %s', (key, expected) => {
    expect(Object.keys(camelize({ [key]: 1 }) as object)).toEqual([expected]);
  });

  it('converts nested keys and leaves values alone', () => {
    expect(
      camelize({
        user_id: 1,
        nested_list: [{ inner_key: 'value_kept' }],
        action: 'chat_message',
      }),
    ).toEqual({
      userId: 1,
      nestedList: [{ innerKey: 'value_kept' }],
      action: 'chat_message',
    });
  });
});

describe('decamelize', () => {
  it.each([
    ['camelCase', 'camel_case'],
    ['getHTTPResponseCode', 'get_http_response_code'],
    ['userID', 'user_id'],
    ['PascalCase', 'pascal_case'],
    ['_leadingCamel', '_leading_camel'],
    ['a1B2', 'a1_b2'],
    ['ID', 'ID'],
  ])('%s -> %s', (key, expected) => {
    expect(Object.keys(decamelize({ [key]: 1 }) as object)).toEqual([expected]);
  });
});
