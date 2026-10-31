import type { SchemaIssue } from './standard-schema';

// Pydantic error types, which ValidationIssue carries, mapped to the JSON Schema
// keyword that fails. Kept identical to chanx's chanx/core/errors.py.
const PYDANTIC_KEYWORDS: Readonly<Record<string, string>> = {
  missing: 'required',
  union_tag_not_found: 'required',
  union_tag_invalid: 'enum',
  literal_error: 'enum',
  enum: 'enum',
  string_too_short: 'minLength',
  string_too_long: 'maxLength',
  string_pattern_mismatch: 'pattern',
  greater_than_equal: 'minimum',
  greater_than: 'exclusiveMinimum',
  less_than_equal: 'maximum',
  less_than: 'exclusiveMaximum',
  multiple_of: 'multipleOf',
  too_short: 'minItems',
  too_long: 'maxItems',
  extra_forbidden: 'additionalProperties',
  uuid_parsing: 'format',
  uuid_version: 'format',
  url_parsing: 'format',
  url_scheme: 'format',
  url_syntax_violation: 'format',
  url_too_long: 'format',
  date_parsing: 'format',
  date_from_datetime_parsing: 'format',
  datetime_parsing: 'format',
  datetime_from_date_parsing: 'format',
  time_parsing: 'format',
  time_delta_parsing: 'format',
};

export function keywordForPydantic(type: string): string {
  const keyword = PYDANTIC_KEYWORDS[type];
  if (keyword) return keyword;
  if (type === 'none_required' || /_(type|parsing|from_float)$/.test(type)) return 'type';
  return 'custom';
}

type Bound = 'min' | 'max';

const BOUNDS: Readonly<Record<Bound, Record<string, string>>> = {
  min: { string: 'minLength', array: 'minItems', set: 'minItems', number: 'minimum' },
  max: { string: 'maxLength', array: 'maxItems', set: 'maxItems', number: 'maximum' },
};

function bound(side: Bound, kind: unknown, inclusive: unknown): string {
  const kindName = kind === 'int' || kind === 'bigint' ? 'number' : String(kind);
  const keyword = BOUNDS[side][kindName];
  if (!keyword) return 'custom';
  if (keyword === 'minimum' && inclusive === false) return 'exclusiveMinimum';
  if (keyword === 'maximum' && inclusive === false) return 'exclusiveMaximum';
  return keyword;
}

// Standard Schema issues carry only a message and a path, so only Zod's own `code`
// (3 and 4) maps to a keyword; other libraries' issues are `custom`.
export function keywordForSchemaIssue(vendor: string, issue: SchemaIssue): string {
  if (vendor !== 'zod') return 'custom';
  const fields = issue as unknown as Record<string, unknown>;
  switch (fields.code) {
    case 'invalid_type':
      return 'type';
    case 'invalid_value':
    case 'invalid_literal':
    case 'invalid_enum_value':
      return 'enum';
    case 'too_small':
      return bound('min', fields.origin ?? fields.type, fields.inclusive);
    case 'too_big':
      return bound('max', fields.origin ?? fields.type, fields.inclusive);
    case 'not_multiple_of':
      return 'multipleOf';
    case 'unrecognized_keys':
      return 'additionalProperties';
    case 'invalid_format':
      return fields.format === 'regex' ? 'pattern' : 'format';
    case 'invalid_string':
      return fields.validation === 'regex' ? 'pattern' : 'format';
  }
  return 'custom';
}
