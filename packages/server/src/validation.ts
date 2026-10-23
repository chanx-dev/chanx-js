import type { AnyMessageDefinition, Message } from './messages';
import type { SchemaIssue } from './standard-schema';

/** One validation error, in the shape pydantic's `errors()` gives chanx clients. */
export interface ValidationIssue {
  type: string;
  loc: Array<string | number>;
  msg: string;
}

export type ValidationResult = { message: Message } | { issues: ValidationIssue[] };

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
    if (!Number.isInteger(value)) {
      issues.push({
        type: 'int_type',
        loc: [key],
        msg: 'Input should be a valid integer',
      });
    }
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

/** Validate a frame against a consumer's messages, as chanx's discriminated union does. */
export function createValidator(messages: readonly AnyMessageDefinition[]) {
  const byAction = new Map(messages.map((message) => [message.action, message]));
  const tags = messages
    .map((message) => `'${message.action}'`)
    .sort()
    .join(', ');

  return async (frame: Frame): Promise<ValidationResult> => {
    if (!('action' in frame)) {
      return {
        issues: [
          {
            type: 'union_tag_not_found',
            loc: [],
            msg: "Unable to extract tag using discriminator 'action'",
          },
        ],
      };
    }
    const definition =
      typeof frame.action === 'string' ? byAction.get(frame.action) : undefined;
    if (!definition) {
      return {
        issues: [
          {
            type: 'union_tag_invalid',
            loc: [],
            msg: `Input tag '${pythonStr(frame.action)}' found using 'action' does not match any of the expected tags: ${tags}`,
          },
        ],
      };
    }
    const payload = await validatePayload(definition, frame, [definition.action]);
    if ('issues' in payload) return payload;
    return { message: { action: definition.action, payload: payload.value } };
  };
}

async function validatePayload(
  definition: AnyMessageDefinition,
  frame: Frame,
  prefix: string[],
): Promise<{ value: unknown } | { issues: ValidationIssue[] }> {
  const loc = [...prefix, 'payload'];
  if (!definition.payload) {
    if (frame.payload === undefined || frame.payload === null) return { value: null };
    return { issues: [{ type: 'none_required', loc, msg: 'Input should be None' }] };
  }
  if (!('payload' in frame)) {
    return { issues: [{ type: 'missing', loc, msg: 'Field required' }] };
  }
  const result = await definition.payload['~standard'].validate(frame.payload);
  if (!result.issues) return { value: result.value };
  return {
    issues: result.issues.map((issue) => ({
      // Schema libraries have no pydantic error types; this is pydantic's generic one.
      type: 'value_error',
      loc: [...loc, ...(issue.path ?? []).map(pathKey)],
      msg: issue.message,
    })),
  };
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
