const PLACEHOLDER = /\{(\w+)\}/g;

/** Names of a pattern's `{placeholder}`s, in order. */
export function patternParams(pattern: string): string[] {
  return [...pattern.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/**
 * Fill a pattern's `{placeholder}`s.
 *
 * Pass `encode` for URLs; topic strings stay raw because the server compares them verbatim.
 */
export function formatPattern(
  pattern: string,
  params: Record<string, string | number> = {},
  encode: (value: string) => string = (value) => value,
): string {
  return pattern.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing parameter "${name}" for pattern "${pattern}"`);
    }
    return encode(String(value));
  });
}

export type PatternMatcher = (value: string) => Record<string, string> | null;

/** Compile a pattern into a matcher returning its params, or `null` on no match. */
export function parsePattern(pattern: string): PatternMatcher {
  const names = patternParams(pattern);
  const literals = pattern.split(PLACEHOLDER).filter((_part, index) => index % 2 === 0);
  // As in chanx, a param stops at ':' so `run:{id}` cannot swallow the next segment.
  const regex = new RegExp(`^${literals.map(escapeRegExp).join('([^:]+)')}$`);

  return (value) => {
    const match = regex.exec(value);
    if (!match) return null;
    return Object.fromEntries(names.map((name, index) => [name, match[index + 1]!]));
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
