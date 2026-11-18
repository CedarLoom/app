import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalHash, canonicalJson } from './canonical-json.ts';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('canonicalJson', () => {
  it('sorts keys at every depth and writes no whitespace', () => {
    const text = canonicalJson({ b: [3, { y: null, x: true }], a: 'é\n', '': 1 });
    expect(text).toBe('{"":1,"a":"é\\n","b":[3,{"x":true,"y":null}]}');
    expect(canonicalJson({ a: 'é\n', '': 1, b: [3, { x: true, y: null }] })).toBe(text);
  });

  it('sorts keys by UTF-16 code units, so an astral key comes before U+E000', () => {
    expect(canonicalJson({ '\uE000': 2, '\u{10000}': 1, z: 0 })).toBe('{"z":0,"\u{10000}":1,"\uE000":2}');
  });

  it('sorts integer-like keys as strings', () => {
    expect(canonicalJson({ a: 0, 9: 1, 10: 2 })).toBe('{"10":2,"9":1,"a":0}');
  });

  it('writes numbers in their shortest form', () => {
    expect(canonicalJson([-0, 1e21, 0.1, 1e-7, 100])).toBe('[0,1e+21,0.1,1e-7,100]');
  });

  it('refuses a lone surrogate in a string or a key', () => {
    expect(() => canonicalJson('\uD800')).toThrow(RangeError);
    expect(() => canonicalJson({ '\uDC00': 1 })).toThrow(RangeError);
    expect(canonicalJson('\u{1F600}')).toBe('"\u{1F600}"');
  });

  it.each([
    ['undefined', undefined],
    ['a member that is undefined', { a: undefined }],
    ['an element that is undefined', [undefined, 1]],
    ['an array with a hole', Object.assign([], { length: 1 })],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a function', () => 1],
    ['a symbol', Symbol('x')],
  ])('refuses %s, which is outside JSON', (_name, value) => {
    // @ts-expect-error The point of the test: the type refuses these, and the function must too.
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it('writes an object with no prototype, as node:sqlite returns its rows', () => {
    expect(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it('refuses a number JSON cannot hold', () => {
    expect(() => canonicalJson([Number.NaN])).toThrow(RangeError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe('canonicalHash', () => {
  it('hashes the UTF-8 bytes of the canonical text', () => {
    expect(canonicalHash({ b: [3, { y: null, x: true }], a: 'é\n', '': 1 }, sha256)).toBe(
      'f8a74332b7617298d2d37d3b78357e7812ac3f13f106a6d43ff0fd75c4a3c722',
    );
  });
});
