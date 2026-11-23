import { compileMessageOrThrow } from '@lingui/message-utils/compileMessage';
import { expect, it } from 'vitest';
import { messageText, printable, printableJson, printableStack } from './message-text.ts';

it('renders a select argument by the branch its value names, null included, else by other', () => {
  const catalog = { m: [['path', 'select', { null: ['none'], other: ['in ', ['path']] }], '.'] };
  expect([null, '/a'].map((path) => messageText(catalog, 'm', { path }))).toEqual(['none.', 'in /a.']);
});

it('renders a plural argument by its exact branch, else its English plural category, with # as the number', () => {
  const catalog = { m: compileMessageOrThrow('{count, plural, =0 {none} one {# problem} other {# problems}}') };
  expect([0, 1, 3].map((count) => messageText(catalog, 'm', { count }))).toEqual(['none', '1 problem', '3 problems']);
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

// The report's lines without its frames.
const headers = (thrown: unknown): string[] =>
  printableStack(thrown)
    .split('\n')
    .filter((line) => !/^ {4}at /.test(line));

const throwing = (property: string): Error =>
  Object.defineProperty(new Error('m'), property, {
    get: () => {
      throw new Error('getter');
    },
  });

const chain = (depth: number): Error => {
  let thrown = new Error('0');
  for (let level = 1; level < depth; level += 1) thrown = new Error(String(level), { cause: thrown });
  return thrown;
};

it.each([
  ['a Symbol message', () => Object.assign(new Error('x'), { message: Symbol('s') }), ['[object Error]']],
  [
    'a null-prototype message',
    () => Object.assign(new Error('x'), { message: Object.create(null) }),
    ['[object Error]'],
  ],
  ['a throwing message getter', () => throwing('message'), ['[object Error]']],
  ['a throwing stack getter', () => throwing('stack'), ['Error: m']],
  ['a throwing cause getter', () => throwing('cause'), ['Error: m', '[cause]: [unreadable]']],
  [
    'an AggregateError whose errors is no array',
    () => Object.defineProperty(new AggregateError([], 'a'), 'errors', { value: 5 }),
    ['AggregateError: a'],
  ],
])('reports an error with %s without throwing', (_, thrown, expected) => {
  expect(headers(thrown())).toEqual(expected);
});

it('cuts a cause chain 20,000 deep after 100 levels with a marker', () => {
  const lines = headers(chain(20_000));
  expect([lines.length, lines[0], lines.at(-1)]).toEqual([101, 'Error: 19999', '[cause]: [cut: more than 100 levels]']);
});

it('reports a line feed in the error name on the header line, so it adds no frame line', () => {
  const thrown = Object.assign(new Error('m'), { name: 'N\n    at fake (n.js:1:1)' });
  expect(headers(thrown)).toEqual(['N\\u000a    at fake (n.js:1:1): m', '{"name":"N\\n    at fake (n.js:1:1)"}']);
});

it('keeps the frames apart when the message text appears again later in the stack', () => {
  const lines = printableStack(new Error('\n')).split('\n');
  expect([lines[0], lines.length > 1, lines.slice(1).every((line) => /^ {4}at /.test(line))]).toEqual([
    'Error: \\u000a',
    true,
    true,
  ]);
});

it('escapes a backslash that starts an escape-like text, so it reads apart from the escaped character', () => {
  expect([printable('\u202e'), printable('\\u202e'), printable('C:\\users')]).toEqual([
    '\\u202e',
    '\\u005cu202e',
    'C:\\users',
  ]);
});

it('leaves the backslashes of JSON text alone, which already escape their own', () => {
  expect(printableJson('{"a":"\\\\u202e\u202e"}')).toBe('{"a":"\\\\u202e\\u202e"}');
});
