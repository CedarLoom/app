import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectReader,
  type NewRun,
  type Opened,
  openRunView,
  openStore,
  type RunStore,
  type StoreClock,
} from './store.ts';

const clock: StoreClock = { now: () => new Date('2026-11-18T22:17:39.123Z'), newRunId: randomUUID };
const folders: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cedarloom-store-'));
  folders.push(dir);
  return dir;
};
// File modes are POSIX; Windows keeps only a read-only flag.
const posixIt = it.skipIf(process.platform === 'win32');
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
  for (const dir of folders.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

const value = <T>(result: Opened<T>): T => {
  if (!result.ok) throw new Error(result.refusal.code);
  return result.value;
};

const store = (dir: string): RunStore => {
  const result = value(openStore(dir, clock));
  opened.push(result);
  return result;
};

const view = (dir: string) => {
  const result = value(openRunView(dir));
  opened.push(result);
  return result;
};

const unreadable = (path: string) => ({ ok: false, refusal: { code: 'store.unreadable', params: { path } } });

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
    expect(store(dir)).toBeDefined();
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
    expect(value(view(dir).runs()).map((run) => run.status)).toEqual(['running']);
    child.kill();
    await once(child, 'exit');
    expect(value(view(dir).runs()).map((run) => run.status)).toEqual(['interrupted']);
  }, 20_000);
});

describe('the run store', () => {
  it('keeps every field of a run', () => {
    const dir = fresh();
    const id = value(store(dir).begin(everyField));
    expect(value(view(dir).run(id))).toEqual({ id, ...everyFieldStored });
  });

  it('gives two runs started at the same moment different ids', () => {
    const dir = fresh();
    const runs = store(dir);
    const ids = [value(runs.begin(newRun)), value(runs.begin(newRun))];
    expect(new Set(ids).size).toBe(2);
    expect(
      value(view(dir).runs())
        .map((run) => run.id)
        .toSorted(),
    ).toEqual(ids.toSorted());
  });

  it('refuses a run its view could not read, and records nothing', () => {
    const dir = fresh();
    expect(() => store(dir).begin({ ...newRun, action: 'undo' })).toThrow('action is undo exactly when kind is undo');
    expect(value(view(dir).runs())).toEqual([]);
  });

  it('names the newest done undo run of a run as the one that undid it', () => {
    const dir = fresh();
    let second = 0;
    const runs = value(
      openStore(dir, { now: () => new Date(Date.UTC(2026, 10, 18, 22, 0, second++)), newRunId: randomUUID }),
    );
    const undo = (id: string): NewRun => ({ ...newRun, kind: 'undo', action: 'undo', subject: id, undoes: id });
    const a = value(runs.begin(newRun));
    const u1 = value(runs.begin(undo(a)));
    const u2 = value(runs.begin(undo(u1)));
    const u3 = value(runs.begin(undo(a)));
    runs.close();
    const db = new DatabaseSync(join(dir, 'runs.sqlite'));
    db.exec(`UPDATE runs SET status = 'done', endedAt = '2026-11-18T22:01:00.000Z'`);
    db.close();
    const undoneBy = new Map(value(view(dir).runs()).map((run) => [run.id, run.undoneBy]));
    expect([undoneBy.get(a), undoneBy.get(u1), undoneBy.get(u2), undoneBy.get(u3)]).toEqual([u3, u2, null, null]);
  });
});

describe('the store files', () => {
  posixIt('creates its files readable by their owner only', () => {
    const dir = fresh();
    chmodSync(dir, 0o755);
    store(dir).begin(newRun);
    const modes = Object.fromEntries(readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mode & 0o777]));
    expect(modes).toEqual({
      'lock.sqlite': 0o600,
      'lock.sqlite-journal': 0o600,
      'runs.sqlite': 0o600,
      'runs.sqlite-shm': 0o600,
      'runs.sqlite-wal': 0o600,
    });
  });

  it('writes the store in WAL mode', () => {
    const dir = fresh();
    store(dir);
    const db = new DatabaseSync(join(dir, 'runs.sqlite'), { readOnly: true });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    db.close();
  });
});

describe('the store refusals', () => {
  posixIt('refuses a read-only lock or store file for writing', () => {
    const dir = fresh();
    store(dir).close();
    opened.length = 0;
    chmodSync(join(dir, 'lock.sqlite'), 0o400);
    expect(openStore(dir, clock)).toEqual(unreadable(join(dir, 'lock.sqlite')));
    chmodSync(join(dir, 'lock.sqlite'), 0o600);
    chmodSync(join(dir, 'runs.sqlite'), 0o400);
    expect(openStore(dir, clock)).toEqual(unreadable(join(dir, 'runs.sqlite')));
  });

  it('refuses a store damaged past its first page, for writing and for reading', () => {
    const dir = fresh();
    store(dir).close();
    opened.length = 0;
    const path = join(dir, 'runs.sqlite');
    const bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes.subarray(0, 4096), Buffer.alloc(bytes.length - 4096, 0x41)]));
    expect([store(dir).begin(newRun), view(dir).runs()]).toEqual([unreadable(path), unreadable(path)]);
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
    const refused = unreadable(join(dir, 'runs.sqlite'));
    expect([openStore(dir, clock), openRunView(dir)]).toEqual([refused, refused]);
  });
});

describe('the read-only view', () => {
  it('reads a missing store as no runs and creates nothing', () => {
    const dir = join(fresh(), 'state');
    expect(value(view(dir).runs())).toEqual([]);
    expect(value(view(dir).run('r1'))).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a lock that is not a database', () => {
    const dir = fresh();
    store(dir).begin(newRun);
    for (const item of opened.splice(0)) item.close();
    writeFileSync(join(dir, 'lock.sqlite'), 'not a database, only text. '.repeat(20));
    expect(view(dir).runs()).toEqual(unreadable(join(dir, 'lock.sqlite')));
  });

  posixIt('refuses a store folder it cannot write, as a read must create runs.sqlite-shm', () => {
    const dir = fresh();
    store(dir).begin(newRun);
    for (const item of opened.splice(0)) item.close();
    chmodSync(dir, 0o500);
    expect(openRunView(dir)).toEqual(unreadable(join(dir, 'runs.sqlite')));
  });

  it('cannot write the store', () => {
    const dir = fresh();
    store(dir).begin(newRun);
    const db = connectReader(join(dir, 'runs.sqlite'));
    expect(() => db.exec('DELETE FROM runs')).toThrow('attempt to write a readonly database');
    db.close();
  });
});
