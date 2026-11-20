import { expect, it } from 'vitest';
import { nestsBeyond } from './json-nesting.ts';

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');
const deep = `${'['.repeat(101)}${']'.repeat(101)}`;

it('leaves brackets inside a string out of the depth', () => {
  expect(nestsBeyond(bytes(JSON.stringify({ description: '['.repeat(200) })), 100)).toBe(false);
});

it('counts the brackets after a string that holds an escaped quote or ends in an escaped backslash', () => {
  expect(nestsBeyond(bytes(`{"a":"\\"","b":${deep}}`), 100)).toBe(true);
  expect(nestsBeyond(bytes(`{"a":"\\\\","b":${deep}}`), 100)).toBe(true);
});
