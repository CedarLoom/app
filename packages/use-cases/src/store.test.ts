import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { connectReader, type NewRun, openRunView, openStore, type RunStore, type StoreClock } from './store.ts';

const clock: StoreClock = { now: () => new Date('2026-11-18T22:17:39.123Z'), newRunId: randomUUID };
const fresh = (): string => mkdtempSync(join(tmpdir(), 'cedarloom-store-'));
const newRun: NewRun = {
  kind: 'apply',
  action: 'workflow.new',
  subject: 'demo',
  undoes: null,
  planHash: 'a'.repeat(64),
  operations: [],
  generatedFrom: [],
};

const entries = [
  { pointer: '/enabledPlugins/x', value: true, before: null },
  { pointer: '/permissions/deny', value: ['Bash(rm:*)'] },
];
const everyField: NewRun = {
  ...newRun,
  operations: [
    { kind: 'create', path: '.claude/a.md', beforeHash: null, afterHash: 'b'.repeat(64), entries: null },
    { kind: 'replace', path: '.claude/settings.json', beforeHash: 'c'.repeat(64), afterHash: 'd'.repeat(64), entries },
  ],
  generatedFrom: [{ name: 'demo', definition: '{"name":"demo"}\n' }],
};
const everyFieldStored = {
  kind: 'apply',
  action: 'workflow.new',
  subject: 'demo',
  status: 'running',
  startedAt: '2026-11-18T22:17:39.123Z',
  endedAt: null,
  undoes: null,
  undoneBy: null,
  planHash: 'a'.repeat(64),
  operations: [
    {
      kind: 'create',
      path: '.claude/a.md',
      beforeHash: null,
      afterHash: 'b'.repeat(64),
      status: 'pending',
      entries: null,
    },
    {
      kind: 'replace',
      path: '.claude/settings.json',
      beforeHash: 'c'.repeat(64),
      afterHash: 'd'.repeat(64),
      status: 'pending',
      entries,
    },
  ],
  generatedFrom: [{ name: 'demo', definition: '{"name":"demo"}\n' }],
};

const opened: { close(): void }[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const item of opened.splice(0)) item.close();
  const running = children.splice(0).filter((child) => child.exitCode === null && child.signalCode === null);
  await Promise.all(running.map((child) => (child.kill(), once(child, 'exit'))));
});

const store = (dir: string): RunStore => {
  const result = openStore(dir, clock);
  if (!result.ok) throw new Error(result.refusal.code);
  opened.push(result.value);
  return result.value;
};

const view = (dir: string) => {
  const result = openRunView(dir);
  if (!result.ok) throw new Error(result.refusal.code);
  opened.push(result.value);
  return result.value;
};

// Another process that opens the store, starts a run and holds the store for `holdMs` (or until it is killed).
const holder = async (dir: string, holdMs: number | 'forever'): Promise<ChildProcess> => {
  const script = `
    import { randomUUID } from 'node:crypto';
    import { openStore } from ${JSON.stringify(new URL('store.ts', import.meta.url).href)};
    const [dir, holdMs] = process.argv.slice(1);
    const store = openStore(dir, { now: () => new Date('2026-11-18T22:00:00.000Z'), newRunId: randomUUID });
    if (!store.ok) throw new Error(store.refusal.code);
    store.value.begin(${JSON.stringify(newRun)});
    process.stdout.write('held\\n');
    if (holdMs === 'forever') setInterval(() => store, 60_000);
    else setTimeout(() => store.value.close(), Number(holdMs));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, dir, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  // A child that fails before it holds the store fails the test instead of leaving it waiting.
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => Promise.reject(new Error(`the holder exited with ${String(code)}`))),
  ]);
  return child;
};

describe('the store lock', () => {
  it('lets a second process wait for the store and take it once the first releases it', async () => {
    const dir = fresh();
    await holder(dir, 300);
    expect(openStore(dir, clock)).toMatchObject({ ok: true });
  }, 20_000);

  it('stops a second process with store.locked while another holds the store past the wait', async () => {
    const dir = fresh();
    await holder(dir, 'forever');
    expect(openStore(dir, clock)).toEqual({
      ok: false,
      refusal: { code: 'store.locked', params: { path: join(dir, 'runs.sqlite') } },
    });
  }, 20_000);

  it('shows a run as running while its process holds the store, and as interrupted once that process is gone', async () => {
    const dir = fresh();
    const child = await holder(dir, 'forever');
    expect(
      view(dir)
        .runs()
        .map((run) => run.status),
    ).toEqual(['running']);
    child.kill();
    await once(child, 'exit');
    expect(
      view(dir)
        .runs()
        .map((run) => run.status),
    ).toEqual(['interrupted']);
  }, 20_000);
});

describe('the run store', () => {
  it('keeps every field of a run', () => {
    const dir = fresh();
    const id = store(dir).begin(everyField);
    expect(view(dir).run(id)).toEqual({ id, ...everyFieldStored });
  });

  it('gives two runs started at the same moment different ids', () => {
    const dir = fresh();
    const runs = store(dir);
    const ids = [runs.begin(newRun), runs.begin(newRun)];
    expect(new Set(ids).size).toBe(2);
    expect(
      view(dir)
        .runs()
        .map((run) => run.id)
        .toSorted(),
    ).toEqual(ids.toSorted());
  });

  it('writes the store in WAL mode', () => {
    const dir = fresh();
    store(dir);
    const db = new DatabaseSync(join(dir, 'runs.sqlite'), { readOnly: true });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    db.close();
  });

  it('refuses a store of another version, for writing and for reading', () => {
    const dir = fresh();
    store(dir).close();
    opened.length = 0;
    const db = new DatabaseSync(join(dir, 'runs.sqlite'));
    db.exec('PRAGMA user_version = 2');
    db.close();
    const refused = { ok: false, refusal: { code: 'store.version-unsupported', params: { found: 2, supported: 1 } } };
    expect([openStore(dir, clock), openRunView(dir)]).toEqual([refused, refused]);
  });

  it('refuses a store that is not a database, for writing and for reading', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'runs.sqlite'), 'not a database, only text. '.repeat(20));
    const refused = { ok: false, refusal: { code: 'store.unreadable', params: { path: join(dir, 'runs.sqlite') } } };
    expect([openStore(dir, clock), openRunView(dir)]).toEqual([refused, refused]);
  });
});

describe('the read-only view', () => {
  it('reads a missing store as no runs and creates nothing', () => {
    const dir = join(fresh(), 'state');
    expect(view(dir).runs()).toEqual([]);
    expect(view(dir).run('r1')).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it('cannot write the store', () => {
    const dir = fresh();
    store(dir).begin(newRun);
    const db = connectReader(join(dir, 'runs.sqlite'));
    expect(() => db.exec('DELETE FROM runs')).toThrow('attempt to write a readonly database');
    db.close();
  });
});
