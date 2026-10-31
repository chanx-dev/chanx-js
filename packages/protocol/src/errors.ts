const ERROR_TYPE_BASE = 'https://chanx.dev/errors/';

/** Problem types: the RFC 9457 `type` an `error` frame's payload carries. */
export const ErrorType = {
  VALIDATION_FAILED: `${ERROR_TYPE_BASE}validation-failed`,
  INVALID_JSON: `${ERROR_TYPE_BASE}invalid-json`,
  HANDLER_FAILED: `${ERROR_TYPE_BASE}handler-failed`,
  INTERNAL_ERROR: `${ERROR_TYPE_BASE}internal-error`,
  UNKNOWN_TOPIC: `${ERROR_TYPE_BASE}unknown-topic`,
  UNAUTHORIZED: `${ERROR_TYPE_BASE}unauthorized`,
  NOT_SUBSCRIBED: `${ERROR_TYPE_BASE}not-subscribed`,
} as const;

export type ErrorType = (typeof ErrorType)[keyof typeof ErrorType];

export const ERROR_TITLES: Readonly<Record<ErrorType, string>> = {
  [ErrorType.VALIDATION_FAILED]: 'Message failed validation',
  [ErrorType.INVALID_JSON]: 'Frame is not valid JSON',
  [ErrorType.HANDLER_FAILED]: 'Message handler failed',
  [ErrorType.INTERNAL_ERROR]: 'Message could not be processed',
  [ErrorType.UNKNOWN_TOPIC]: 'Unknown topic',
  [ErrorType.UNAUTHORIZED]: 'Subscription not allowed',
  [ErrorType.NOT_SUBSCRIBED]: 'Not subscribed to topic',
};

/** One entry of {@link ProblemDetails}.errors. */
export interface ValidationFailure {
  /** The JSON Schema keyword that failed, or `custom` for a check a schema cannot express. */
  keyword: string;
  /** A JSON Pointer to the failing value in the frame; for `required`, the object lacking the member. */
  pointer: string;
  /** Human-readable; the wording differs between implementations. */
  detail: string;
  /** For `required` only: the missing member. */
  property?: string | number;
}

/** The payload of a chanx `error` frame: an RFC 9457 problem details object. */
export interface ProblemDetails {
  /** What went wrong; branch on this. */
  type: ErrorType;
  /** Fixed for each type. */
  title: string;
  /** This occurrence, for people. */
  detail: string;
  /** An HTTP status; chanx never sends one over a WebSocket. */
  status?: number;
  /** A URI reference for this occurrence; chanx never sends one. */
  instance?: string;
  /** Present when `type` is validation-failed. */
  errors?: ValidationFailure[];
}

/** Whether an `error` frame's payload is in the standard format, as opposed to a custom one. */
export function isProblem(payload: unknown): payload is ProblemDetails {
  if (typeof payload !== 'object' || payload === null) return false;
  const { type, title, detail } = payload as Record<string, unknown>;
  return (
    typeof type === 'string' &&
    type.startsWith(ERROR_TYPE_BASE) &&
    typeof title === 'string' &&
    typeof detail === 'string'
  );
}

/** A standard `error` payload of a given type, for hooks that send their own. */
export function problem(
  type: ErrorType,
  detail: string,
  errors?: ValidationFailure[],
): ProblemDetails {
  const payload: ProblemDetails = { type, title: ERROR_TITLES[type], detail };
  if (errors) payload.errors = errors;
  return payload;
}

/** An RFC 6901 JSON Pointer. */
export function jsonPointer(path: readonly (string | number)[]): string {
  return path
    .map((segment) => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}

/**
 * Follow a validator's location through the data, as every chanx does: segments that
 * name nothing there (union member labels, a discriminator tag) are dropped, and a last
 * segment absent from an object is returned as the missing member.
 */
export function instancePath(
  loc: readonly (string | number)[],
  data: unknown,
): { path: (string | number)[]; missing?: string | number } {
  const path: (string | number)[] = [];
  let node = data;
  for (const [index, segment] of loc.entries()) {
    const object = isRecord(node) ? node : undefined;
    if (object && typeof segment === 'string' && Object.hasOwn(object, segment)) {
      node = object[segment];
    } else if (
      Array.isArray(node) &&
      typeof segment === 'number' &&
      segment >= 0 &&
      segment < node.length
    ) {
      node = node[segment];
    } else if (index === loc.length - 1 && object) {
      return { path, missing: segment };
    } else {
      continue;
    }
    path.push(segment);
  }
  return { path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
