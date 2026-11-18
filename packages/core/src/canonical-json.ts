import { z } from 'zod';

/** A JSON value as `JSON.parse` returns it. */
export const JsonValue = z.json();
export type JsonValue = z.infer<typeof JsonValue>;

/** A hash function over bytes; CedarLoom passes SHA-256 as 64 lowercase hex digits. */
export type Hasher = (bytes: Uint8Array) => string;

// RFC 8785, section 3.2.3: keys sort by their UTF-16 code units, which is how JavaScript compares strings.
const byKey = ([a]: readonly [string, JsonValue], [b]: readonly [string, JsonValue]): number => (a < b ? -1 : 1);

/** JSON text with sorted keys and no whitespace, so equal values give equal text: RFC 8785 (JCS). */
export const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  // JSON.stringify writes null for these, which would hash a value other than the one given.
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`${value} has no JSON form`);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const members = Object.entries(value).toSorted(byKey);
  return `{${members.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
};

/** The hash of a value's canonical JSON, encoded as UTF-8. */
export const canonicalHash = (value: JsonValue, hash: Hasher): string =>
  hash(new TextEncoder().encode(canonicalJson(value)));
