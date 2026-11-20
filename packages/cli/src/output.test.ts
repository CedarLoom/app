import { expect, it } from 'vitest';
import { refused, write } from './output.ts';

it('escapes C1, format and separator characters in the --json document, equal after parsing', () => {
  const out: string[] = [];
  const run = 'r\u009b\u202e\u2028\u{e0001}';
  write(refused({ code: 'run.not-found', params: { run } }), true, {
    stdout: (text) => out.push(text),
    stderr: () => {},
  });
  expect([out.join(''), JSON.parse(out.join('')).refusals[0].params.run]).toEqual([
    '{"result":null,"findings":[],"refusals":[{"code":"run.not-found","params":{"run":"r\\u009b\\u202e\\u2028\\udb40\\udc01"}}]}\n',
    run,
  ]);
});
