import { instancePath } from '@chanx-js/protocol';

import { keywordForPydantic, keywordForSchemaIssue } from './keywords';
import type { AnyMessageDefinition, Message } from './messages';
import type { SchemaIssue } from './standard-schema';

/** One validation error, in the shape pydantic's `errors()` gives chanx clients. */
export interface ValidationIssue {
  type: string;
  loc: Array<string | number>;
  msg: string;
}

/** A failure in the standard format, with its location as segments until the wire casing is known. */
export interface ErrorItem {
  keyword: string;
  path: (string | number)[];
  detail: string;
  property?: string | number;
}

export type ValidationResult =
  { message: Message } | { issues: ValidationIssue[]; errors: ErrorItem[] };

export function errorItems(
  issues: readonly ValidationIssue[],
  data: unknown,
): ErrorItem[] {
  return issues.map((issue) => {
    const item: ErrorItem = {
      keyword: keywordForPydantic(issue.type),
      path: [],
      detail: issue.msg,
    };
    if (issue.type === 'union_tag_not_found') {
      item.property = 'action';
    } else if (issue.type === 'union_tag_invalid') {
      item.path = ['action'];
    } else {
      const { path, missing } = instancePath(issue.loc, data);
      item.path = path;
      if (issue.type === 'missing' && missing !== undefined) item.property = missing;
    }
    return item;
  });
}

type Frame = Record<string, unknown>;

export function isObject(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The envelope fields, checked as chanx's `Envelope` model checks them. */
export function envelopeIssues(frame: unknown): ValidationIssue[] {
  if (!isObject(frame)) {
    return [
      {
        type: 'model_type',
        loc: [],
        msg: 'Input should be a valid dictionary or instance of Envelope',
      },
    ];
  }
  const issues: ValidationIssue[] = [];
  const integer = (key: string, optional: boolean) => {
    const value = frame[key];
    if (value === undefined || (optional && value === null)) return;
    const issue = laxIntegerIssue(value);
    if (issue) issues.push({ ...issue, loc: [key] });
  };
  const string = (key: string) => {
    const value = frame[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      issues.push({
        type: 'string_type',
        loc: [key],
        msg: 'Input should be a valid string',
      });
    }
  };
  integer('version', false);
  string('topic');
  string('ref');
  integer('seq', true);
  return issues;
}

// Pydantic's lax int, which chanx's Envelope applies: "12", " 7 ", "1_000", "12.0", true
// and 1.0 are integers; 1.5 and "1.5" are not.
const INTEGER_STRING = /^[+-]?\d+(?:_\d+)*(?:\.0+)?$/;

function laxIntegerIssue(value: unknown): Omit<ValidationIssue, 'loc'> | undefined {
  if (typeof value === 'boolean' || Number.isInteger(value)) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return {
      type: 'int_from_float',
      msg: 'Input should be a valid integer, got a number with a fractional part',
    };
  }
  if (typeof value === 'string') {
    if (INTEGER_STRING.test(value.trim())) return undefined;
    return {
      type: 'int_parsing',
      msg: 'Input should be a valid integer, unable to parse string as an integer',
    };
  }
  return { type: 'int_type', msg: 'Input should be a valid integer' };
}

/** Validate a frame against a consumer's messages, as chanx's discriminated union does. */
export function createValidator(messages: readonly AnyMessageDefinition[]) {
  const byAction = new Map(messages.map((message) => [message.action, message]));
  const tags = messages
    .map((message) => `'${message.action}'`)
    .sort()
    .join(', ');

  const failed = (issues: ValidationIssue[], frame: Frame) => ({
    issues,
    errors: errorItems(issues, frame),
  });

  return async (frame: Frame): Promise<ValidationResult> => {
    if (!('action' in frame)) {
      return failed(
        [
          {
            type: 'union_tag_not_found',
            loc: [],
            msg: "Unable to extract tag using discriminator 'action'",
          },
        ],
        frame,
      );
    }
    const definition =
      typeof frame.action === 'string' ? byAction.get(frame.action) : undefined;
    if (!definition) {
      return failed(
        [
          {
            type: 'union_tag_invalid',
            loc: [],
            msg: `Input tag '${pythonStr(frame.action)}' found using 'action' does not match any of the expected tags: ${tags}`,
          },
        ],
        frame,
      );
    }
    const payload = await validatePayload(definition, frame, [definition.action]);
    if ('issues' in payload) {
      return {
        issues: payload.issues,
        errors: payload.errors ?? errorItems(payload.issues, frame),
      };
    }
    return { message: { action: definition.action, payload: payload.value } };
  };
}

async function validatePayload(
  definition: AnyMessageDefinition,
  frame: Frame,
  prefix: string[],
): Promise<{ value: unknown } | { issues: ValidationIssue[]; errors?: ErrorItem[] }> {
  const loc = [...prefix, 'payload'];
  if (!definition.payload) {
    if (frame.payload === undefined || frame.payload === null) return { value: null };
    return { issues: [{ type: 'none_required', loc, msg: 'Input should be None' }] };
  }
  if (!('payload' in frame)) {
    return { issues: [{ type: 'missing', loc, msg: 'Field required' }] };
  }
  const schema = definition.payload['~standard'];
  // Awaiting only an async result keeps handlers starting in arrival order, as in chanx.
  const validated = schema.validate(frame.payload);
  const result = validated instanceof Promise ? await validated : validated;
  if (!result.issues) return { value: result.value };
  return {
    issues: result.issues.map((issue) => ({
      // Schema libraries have no pydantic error types; this is pydantic's generic one.
      type: 'value_error',
      loc: [...loc, ...(issue.path ?? []).map(pathKey)],
      msg: issue.message,
    })),
    errors: result.issues.flatMap((issue) =>
      schemaErrorItems(schema.vendor, issue, frame.payload),
    ),
  };
}

function schemaErrorItems(
  vendor: string,
  issue: SchemaIssue,
  payload: unknown,
): ErrorItem[] {
  const loc = (issue.path ?? []).map(pathKey);
  const { path, missing } = instancePath(loc, payload);
  const at = ['payload', ...path];
  if (missing !== undefined) {
    return [{ keyword: 'required', path: at, detail: issue.message, property: missing }];
  }
  const keyword = keywordForSchemaIssue(vendor, issue);
  const extra = (issue as unknown as { keys?: unknown }).keys;
  if (keyword === 'additionalProperties' && Array.isArray(extra)) {
    // Zod reports every unknown key on the object; chanx points at each key.
    return extra.map((key) => ({
      keyword,
      path: [...at, String(key)],
      detail: issue.message,
    }));
  }
  return [{ keyword, path: at, detail: issue.message }];
}

function pathKey(segment: NonNullable<SchemaIssue['path']>[number]): string | number {
  const key = typeof segment === 'object' ? segment.key : segment;
  return typeof key === 'number' ? key : String(key);
}

function pythonStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
