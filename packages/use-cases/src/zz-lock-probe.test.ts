// Temporary probe of the store lock hand-off on CI; removed before the final push.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, fsyncSync, mkdtempSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'vitest';
import { openRunView, openStore } from './store.ts';

const now = (): number => performance.timeOrigin + performance.now();
const r = (n: number): number => Math.round(n);
const clock = { now: () => new Date('2026-11-18T22:00:00.000Z'), newRunId: () => crypto.randomUUID() };

const holderScript = `
  import { randomUUID } from 'node:crypto';
  import { openStore } from ${JSON.stringify(new URL('store.ts', import.meta.url).href)};
  const now = () => performance.timeOrigin + performance.now();
  const [dir, holdMs] = process.argv.slice(1);
  const store = openStore(dir, { now: () => new Date('2026-11-18T22:00:00.000Z'), newRunId: randomUUID });
  if (!store.ok) throw new Error(store.refusal.code);
  store.value.begin({ kind: 'apply', action: 'workflow.new', subject: 'demo', undoes: null, planHash: 'a'.repeat(64), operations: [], generatedFrom: [] });
  process.stdout.write(JSON.stringify({ held: now() }) + '\\n');
  if (holdMs === 'forever') setInterval(() => store, 60_000);
  else setTimeout(() => {
    const c0 = now();
    store.value.close();
    process.stdout.write(JSON.stringify({ c0, c1: now() }) + '\\n');
  }, Number(holdMs));
`;

describe('lock probe', () => {
  it('hands off under load', async () => {
    const burners = Array.from({ length: cpus().length + 2 }, () =>
      spawn(process.execPath, ['--eval', 'for (;;) {}'], { stdio: 'ignore' }),
    );
    const rows: Record<string, number | string>[] = [];
    try {
      for (let i = 0; i < 60; i += 1) {
        const dir = mkdtempSync(join(tmpdir(), 'cedarloom-probe-'));
        const child = spawn(process.execPath, ['--input-type=module', '--eval', holderScript, dir, '300'], {
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        const spawned = now();
        await once(child.stdout, 'data');
        const t0 = now();
        const result = openStore(dir, clock);
        const t1 = now();
        if (result.ok) result.value.close();
        await once(child, 'close');
        const lines = out
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, number>);
        const held = lines[0]?.['held'] ?? Number.NaN;
        const c0 = lines[1]?.['c0'] ?? Number.NaN;
        const c1 = lines[1]?.['c1'] ?? Number.NaN;
        rows.push({
          i,
          ok: result.ok ? 'ok' : result.refusal.code,
          startup: r(held - spawned),
          attemptAt: r(t0 - held),
          doneAt: r(t1 - held),
          closeStart: r(c0 - held),
          closeEnd: r(c1 - held),
        });
      }
    } finally {
      for (const burner of burners) burner.kill();
    }
    const max = (key: string) => Math.max(...rows.map((row) => Number(row[key])));
    const odd = rows.filter(
      (row) => row['ok'] !== 'ok' || Number(row['doneAt']) > 600 || Number(row['closeEnd']) > 400,
    );
    throw new Error(
      `PROBE handoff ${process.platform} cpus=${cpus().length} failures=${rows.filter((row) => row['ok'] !== 'ok').length} ` +
        `max startup=${max('startup')} doneAt=${max('doneAt')} closeStart=${max('closeStart')} closeEnd=${max('closeEnd')}\n` +
        odd.map((row) => JSON.stringify(row)).join('\n'),
    );
  }, 300_000);

  it('costs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedarloom-probe-'));
    const file = join(dir, 'f');
    writeFileSync(file, 'x');
    const t0 = now();
    for (let i = 0; i < 200; i += 1) closeSync(openSync(file, 'r'));
    const openMs = (now() - t0) / 200;
    const t1 = now();
    for (let i = 0; i < 50; i += 1) closeSync(openSync(join(dir, `n${i}`), 'wx'));
    const createMs = (now() - t1) / 50;
    const fd = openSync(file, 'w');
    const t2 = now();
    for (let i = 0; i < 50; i += 1) {
      writeSync(fd, 'x');
      fsyncSync(fd);
    }
    const fsyncMs = (now() - t2) / 50;
    closeSync(fd);
    const state = join(dir, 'state');
    const t3 = now();
    for (let i = 0; i < 20; i += 1) {
      const held = openStore(state, clock);
      if (held.ok) held.value.close();
    }
    const storeMs = (now() - t3) / 20;
    const t4 = now();
    for (let i = 0; i < 20; i += 1) {
      const view = openRunView(state);
      if (view.ok) {
        view.value.runs();
        view.value.close();
      }
    }
    const viewMs = (now() - t4) / 20;
    const db = new DatabaseSync(join(dir, 'd.sqlite'));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE t (x)');
    const t5 = now();
    for (let i = 0; i < 50; i += 1) db.exec('INSERT INTO t VALUES (1)');
    const commitMs = (now() - t5) / 50;
    db.close();
    const f = (n: number) => n.toFixed(2);
    throw new Error(
      `PROBE costs ${process.platform} open=${f(openMs)} create=${f(createMs)} fsync=${f(fsyncMs)} commit=${f(commitMs)} store=${f(storeMs)} view=${f(viewMs)}`,
    );
  });
});
