import { z } from 'zod';

// z.json() drops a "__proto__" member without an error, so the input is checked before it parses.
const hasProtoMember = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasProtoMember);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, item]) => key === '__proto__' || hasProtoMember(item));
};

/** A JSON value as `JSON.parse` returns it; a "__proto__" member is refused, not dropped. */
export const JsonValue = z
  .custom<unknown>((value) => !hasProtoMember(value), 'a "__proto__" member cannot be stored')
  .pipe(z.json());
export type JsonValue = z.infer<typeof JsonValue>;

/** A hash function over bytes; CedarLoom passes SHA-256 as 64 lowercase hex digits. */
export type Hasher = (bytes: Uint8Array) => string;

// RFC 8785, section 3.2.3: keys sort by their UTF-16 code units, which is how JavaScript compares strings.
const byKey = ([a]: readonly [string, JsonValue], [b]: readonly [string, JsonValue]): number => (a < b ? -1 : 1);

// RFC 8785, section 3.2.2.2: a lone surrogate is an error, where JSON.stringify would escape it.
const quoted = (text: string): string => {
  if (!text.isWellFormed()) throw new RangeError('a string with a lone surrogate has no JSON form');
  return JSON.stringify(text);
};

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** JSON text with sorted keys and no whitespace, so equal values give equal text: RFC 8785 (JCS). */
export const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'string') return quoted(value);
  // JSON.stringify writes null for these, which would hash a value other than the one given.
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`${value} has no JSON form`);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  // A value outside JsonValue (undefined, a function, a Date) would otherwise give text that is not JSON, or {}.
  if (typeof value !== 'object' || !isPlainObject(value)) throw new TypeError('the value has no JSON form');
  const members = Object.entries(value).toSorted(byKey);
  return `{${members.map(([key, item]) => `${quoted(key)}:${canonicalJson(item)}`).join(',')}}`;
};

/** The hash of a value's canonical JSON, encoded as UTF-8. */
export const canonicalHash = (value: JsonValue, hash: Hasher): string =>
  hash(new TextEncoder().encode(canonicalJson(value)));
