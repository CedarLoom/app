// Temporary probe of the store lock hand-off on CI; removed before the final push.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, fsyncSync, mkdtempSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openStore } from './store.ts';

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

const stage = (path: string, work: (db: DatabaseSync) => void) => {
  const t0 = now();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { timeout: 1000 });
    work(db);
    return { ok: true, t0, t1: now(), db };
  } catch (error) {
    db?.close();
    return { ok: false, t0, t1: now(), err: String((error as { errcode?: number }).errcode), db: undefined };
  }
};

describe('lock probe', () => {
  it('hands off', async () => {
    const rows: unknown[] = [];
    let failures = 0;
    for (let i = 0; i < 40; i += 1) {
      const dir = mkdtempSync(join(tmpdir(), 'cedarloom-probe-'));
      const child = spawn(process.execPath, ['--input-type=module', '--eval', holderScript, dir, '300'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      const spawned = now();
      await once(child.stdout, 'data');
      const recv = now();
      const lock = stage(join(dir, 'lock.sqlite'), (db) => {
        db.exec('PRAGMA journal_mode = MEMORY');
        db.exec('BEGIN EXCLUSIVE');
        db.exec('PRAGMA user_version = 0');
      });
      const runs = lock.ok
        ? stage(join(dir, 'runs.sqlite'), (db) => {
            db.prepare('PRAGMA user_version').get();
            db.exec('BEGIN IMMEDIATE');
            db.exec('ROLLBACK');
          })
        : undefined;
      runs?.db?.close();
      lock.db?.close();
      await once(child, 'exit');
      const lines = out
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, number>);
      const held = lines[0]?.['held'] ?? Number.NaN;
      const c0 = lines[1]?.['c0'] ?? Number.NaN;
      const c1 = lines[1]?.['c1'] ?? Number.NaN;
      if (!lock.ok || runs?.ok === false) failures += 1;
      rows.push({
        i,
        startup: r(held - spawned),
        pipe: r(recv - held),
        lock: lock.ok ? 'ok' : lock.err,
        lockAt: r(lock.t1 - held),
        runs: runs === undefined ? '-' : runs.ok ? 'ok' : runs.err,
        runsMs: runs === undefined ? '-' : r(runs.t1 - runs.t0),
        closeStart: r(c0 - held),
        closeMs: r(c1 - c0),
      });
    }
    throw new Error(
      `PROBE handoff ${process.platform} failures=${failures}\n${rows.map((row) => JSON.stringify(row)).join('\n')}`,
    );
  }, 300_000);

  it('waits', async () => {
    const waits: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const dir = mkdtempSync(join(tmpdir(), 'cedarloom-probe-'));
      const child = spawn(process.execPath, ['--input-type=module', '--eval', holderScript, dir, 'forever'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      await once(child.stdout, 'data');
      const t0 = now();
      const result = openStore(dir, clock);
      waits.push(r(now() - t0));
      expect(result.ok).toBe(false);
      child.kill();
      await once(child, 'exit');
    }
    throw new Error(`PROBE wait ${process.platform} ${JSON.stringify(waits)}`);
  }, 60_000);

  it('syncs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedarloom-probe-'));
    const fd = openSync(join(dir, 'f'), 'w');
    const t0 = now();
    for (let i = 0; i < 50; i += 1) {
      writeSync(fd, 'x');
      fsyncSync(fd);
    }
    const fsyncMs = (now() - t0) / 50;
    closeSync(fd);
    const db = new DatabaseSync(join(dir, 'd.sqlite'));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE t (x)');
    const t1 = now();
    for (let i = 0; i < 50; i += 1) db.exec('INSERT INTO t VALUES (1)');
    const commitMs = (now() - t1) / 50;
    db.close();
    throw new Error(`PROBE sync ${process.platform} fsync=${fsyncMs.toFixed(1)}ms commit=${commitMs.toFixed(1)}ms`);
  });
});
