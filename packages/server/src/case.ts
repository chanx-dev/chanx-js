// pyhumps' rules, so a camelized server talks to the same clients as Python's.

const ACRONYM = /([A-Z\d]+)(?=[A-Z\d]|$)/g;
const SPLIT = /([-_]*[A-Z][^A-Z]*[-_]*)/;
const UNDERSCORE = /(?<=[^-_])[-_]+[^-_]/g;

const isUpper = (text: string) =>
  text !== text.toLowerCase() && text === text.toUpperCase();
const isNumeric = (text: string) => /^\d+$/.test(text);

function camelizeKey(key: string): string {
  let text = key.replace(/\s+/g, '');
  if (isUpper(text) || isNumeric(text)) return key;
  if (text && !isUpper(text.slice(0, 2))) text = text[0]!.toLowerCase() + text.slice(1);
  return text.replace(UNDERSCORE, (match) => match.at(-1)!.toUpperCase());
}

function decamelizeKey(key: string): string {
  const text = key.replace(/\s+/g, '');
  if (isUpper(text) || isNumeric(text)) return key;
  const fixed = text.replace(ACRONYM, titleCase);
  return fixed.split(SPLIT).filter(Boolean).join('_').toLowerCase();
}

// Python's str.title(): a letter is upper-cased after any non-letter.
function titleCase(text: string): string {
  let previousIsLetter = false;
  let out = '';
  for (const char of text) {
    const isLetter = char.toLowerCase() !== char.toUpperCase();
    out += isLetter ? (previousIsLetter ? char.toLowerCase() : char.toUpperCase()) : char;
    previousIsLetter = isLetter;
  }
  return out;
}

function convertKeys(value: unknown, convert: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => convertKeys(item, convert));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      convert(key),
      convertKeys(item, convert),
    ]),
  );
}

export const camelize = (value: unknown) => convertKeys(value, camelizeKey);
export { camelizeKey, decamelizeKey };
export const decamelize = (value: unknown) => convertKeys(value, decamelizeKey);
