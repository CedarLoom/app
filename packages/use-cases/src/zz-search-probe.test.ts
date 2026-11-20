// Temporary probe of where undo-search spends its time on CI; removed before the final push.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterAll } from 'vitest';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const sqlite = require('node:sqlite');
const spent: Record<string, [number, number]> = {};
const timed = <T extends (...args: never[]) => unknown>(name: string, fn: T): T =>
  function (this: unknown, ...args: never[]) {
    const t0 = performance.now();
    try {
      return fn.apply(this, args);
    } finally {
      const entry = (spent[name] ??= [0, 0]);
      entry[0] += 1;
      entry[1] += performance.now() - t0;
    }
  } as T;
for (const name of Object.keys(fs).filter((key) => key.endsWith('Sync'))) fs[name] = timed(name, fs[name]);
syncBuiltinESMExports();
const proto = sqlite.DatabaseSync.prototype;
for (const name of ['exec', 'close', 'open']) if (proto[name]) proto[name] = timed(`db.${name}`, proto[name]);
const prepare = proto.prepare;
proto.prepare = function (this: unknown, sql: string) {
  const statement = prepare.call(this, sql);
  for (const name of ['run', 'get', 'all']) statement[name] = timed(`st.${name}`, statement[name].bind(statement));
  return statement;
};
const start = performance.now();
afterAll(() => {
  const total = performance.now() - start;
  const rows = Object.entries(spent)
    .toSorted((a, b) => b[1][1] - a[1][1])
    .map(([name, [count, ms]]) => `${name} n=${count} ms=${ms.toFixed(0)}`);
  throw new Error(`PROBE search ${process.platform} total=${total.toFixed(0)}\n${rows.join('\n')}`);
});
await import('./undo-search.test.ts');
