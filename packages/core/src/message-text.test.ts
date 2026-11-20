import { compileMessageOrThrow } from '@lingui/message-utils/compileMessage';
import { expect, it } from 'vitest';
import { messageText, printableLines, printableStack } from './message-text.ts';

it('renders a select argument by the branch its value names, null included, else by other', () => {
  const catalog = { m: [['path', 'select', { null: ['none'], other: ['in ', ['path']] }], '.'] };
  expect([null, '/a'].map((path) => messageText(catalog, 'm', { path }))).toEqual(['none.', 'in /a.']);
});

it('renders a plural argument by its exact branch, else its English plural category, with # as the number', () => {
  const catalog = { m: compileMessageOrThrow('{count, plural, =0 {none} one {# problem} other {# problems}}') };
  expect([0, 1, 3].map((count) => messageText(catalog, 'm', { count }))).toEqual(['none', '1 problem', '3 problems']);
});

it('escapes C0, C1, format and separator characters, U+2029 included, and keeps the line feeds of a multi-line text', () => {
  expect(printableLines('a \u009b‮\nb\u0000')).toBe('a\\u2029\\u009b\\u202e\nb\\u0000');
});

it('reports a line feed in an error message on the message line, so it adds no frame line', () => {
  const lines = printableStack(new Error('disk gone\n    at forged (/x.js:1:1)')).split('\n');
  expect(lines[0]).toBe('Error: disk gone\\u000a    at forged (/x.js:1:1)');
  expect(lines.slice(1).every((line) => /^ {4}at /.test(line))).toBe(true);
});

it("reports the cause chain and an AggregateError's errors to any depth, with each error's own fields", () => {
  const step = Object.assign(new Error('step'), { findings: [{ params: { path: { deep: '.claude/a.md' } } }] });
  const thrown = new Error('l1', { cause: new Error('l2', { cause: new AggregateError([step, 'gone'], 'l3') }) });
  const headers = printableStack(thrown)
    .split('\n')
    .filter((line) => !/^ {4}at /.test(line));
  expect(headers).toEqual([
    'Error: l1',
    '[cause]: Error: l2',
    '[cause]: AggregateError: l3',
    '[errors]: Error: step',
    '{"findings":[{"params":{"path":{"deep":".claude/a.md"}}}]}',
    '[errors]: gone',
  ]);
});

it('reports a message that is no string and a toJSON that gives undefined', () => {
  const thrown = Object.assign(new Error('x'), { message: 42, toJSON: () => undefined });
  expect(printableStack(thrown).split('\n')[0]).toBe('Error: 42');
  expect(printableStack({ toJSON: () => undefined })).toBe('[object Object]');
});
