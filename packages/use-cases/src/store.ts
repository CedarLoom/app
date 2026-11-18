import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { type Refusal, Run, RunSummary } from '@cedarloom/core';

/** The store schema version this CedarLoom reads and writes; a store of any other version is refused. */
const VERSION = 1;
// How long a process waits for another one: for the store lock, and for WAL cleanup and recovery in runs.sqlite.
const WAIT_MS = 1000;

// Every field of Run: undoneBy is not stored but read from the done undo run that names the run.
const SCHEMA = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  undoes TEXT REFERENCES runs (id),
  planHash TEXT NOT NULL,
  generatedFrom TEXT NOT NULL
) STRICT;
CREATE TABLE operations (
  runId TEXT NOT NULL REFERENCES runs (id),
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  beforeHash TEXT,
  afterHash TEXT,
  status TEXT NOT NULL,
  entries TEXT,
  PRIMARY KEY (runId, position)
) STRICT;
CREATE INDEX runs_undoes ON runs (undoes);
PRAGMA user_version = ${VERSION};
`;

const SUMMARY_COLUMNS = `r.id, r.kind, r.action, r.subject, r.status, r.startedAt, r.endedAt, r.undoes,
  (SELECT u.id FROM runs u WHERE u.undoes = r.id AND u.status = 'done' ORDER BY u.startedAt DESC, u.rowid DESC LIMIT 1)
    AS undoneBy`;

/** What a use case gets from the store: the value, or the refusal that stops it. */
export type Opened<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

/** A run as its use case starts it; the store adds the id, the status, the times and each operation's status. */
export type NewRun = Pick<Run, 'kind' | 'action' | 'subject' | 'undoes' | 'planHash' | 'generatedFrom'> & {
  operations: Pending<Run['operations'][number]>[];
};
// Omit per member of the union, so each operation kind keeps its own hashes.
type Pending<T> = T extends unknown ? Omit<T, 'status'> : never;

/** The time and the run ids a store uses. */
export interface StoreClock {
  now: () => Date;
  newRunId: () => string;
}

const runsPath = (dir: string): string => join(dir, 'runs.sqlite');
const lockPath = (dir: string): string => join(dir, 'lock.sqlite');

// SQLite's primary result codes, without the extended bits.
const BUSY = 5;
const UNREADABLE = new Set([8, 11, 14, 26]); // SQLITE_READONLY, SQLITE_CORRUPT, SQLITE_CANTOPEN, SQLITE_NOTADB
// Node's codes for a store file or folder this user may not create or write, such as one a sudo run left to root.
const DENIED = new Set(['EACCES', 'EPERM', 'EROFS']);

const resultCode = (error: unknown): number | undefined =>
  error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' ? error.errcode & 0xff : undefined;

const nodeCode = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined);

// store.unreadable for an error about a store file or folder this process cannot use; any other error propagates.
const unreadable = (error: unknown, file: string): Refusal => {
  const sqlite = resultCode(error);
  const node = nodeCode(error);
  if ((sqlite !== undefined && UNREADABLE.has(sqlite)) || (typeof node === 'string' && DENIED.has(node))) {
    return { code: 'store.unreadable', params: { path: file } };
  }
  throw error;
};

// For a change, a busy store is held by another process.
const refusalFor = (error: unknown, dir: string, file: string): Refusal =>
  resultCode(error) === BUSY ? { code: 'store.locked', params: { path: runsPath(dir) } } : unreadable(error, file);

// A read takes no store lock, so it never refuses with store.locked: a file still busy after the wait is unreadable.
const readRefusal = (error: unknown, file: string): Refusal =>
  resultCode(error) === BUSY ? { code: 'store.unreadable', params: { path: file } } : unreadable(error, file);

// SQLite creates a file 0644 and gives its -wal, -shm and -journal files the database file's mode, so the file is
// created 0600 first. SQLite opens an existing read-only file read-only, and a read-only lock.sqlite excludes nobody.
const writable = (path: string): void => {
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    // An existing file is not opened here: closing it would drop this process's SQLite locks on it.
    if (nodeCode(error) !== 'EEXIST') throw error;
    accessSync(path, constants.W_OK);
  }
};

const pragma = (db: DatabaseSync, name: string): SQLOutputValue | undefined =>
  db.prepare(`PRAGMA ${name}`).get()?.[name];

const versionRefusal = (found: SQLOutputValue | undefined): Refusal => ({
  code: 'store.version-unsupported',
  params: { found: Number(found), supported: VERSION },
});

const transaction = <T>(db: DatabaseSync, work: () => T): T => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // SQLite rolls back by itself on some errors, such as a full disk; a second ROLLBACK would hide the cause.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
};

// Read back, since SQLite keeps another journal mode without an error where the filesystem cannot share memory.
// fullfsync flushes the drive's cache on macOS, where fsync does not; elsewhere it changes nothing.
const durable = (db: DatabaseSync): void => {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA foreign_keys = ON');
  const journal = pragma(db, 'journal_mode');
  const synchronous = pragma(db, 'synchronous');
  const fullfsync = pragma(db, 'fullfsync');
  if (journal !== 'wal' || synchronous !== 2 || fullfsync !== 1) {
    throw new Error(
      `the store runs with journal_mode ${String(journal)}, synchronous ${String(synchronous)} and fullfsync ${String(fullfsync)}`,
    );
  }
};

// runs.sqlite for writing, given the store lock; a new store gets schema version 1, another version is refused.
const connectWriter = (path: string): Opened<DatabaseSync> => {
  const db = new DatabaseSync(path, { timeout: WAIT_MS });
  try {
    const found = pragma(db, 'user_version');
    if (found !== 0 && found !== VERSION) {
      db.close();
      return { ok: false, refusal: versionRefusal(found) };
    }
    durable(db);
    if (found === 0) transaction(db, () => db.exec(SCHEMA));
    return { ok: true, value: db };
  } catch (error) {
    db.close();
    throw error;
  }
};

/** runs.sqlite opened read-only, so a read cannot write the store. */
export const connectReader = (path: string): DatabaseSync =>
  new DatabaseSync(path, { readOnly: true, timeout: WAIT_MS });

/** The run store, held by one process at a time: the OS frees its lock when the process ends in any way. */
export class RunStore {
  readonly #db: DatabaseSync;
  readonly #lock: DatabaseSync;
  readonly #clock: StoreClock;
  readonly #dir: string;

  constructor(db: DatabaseSync, lock: DatabaseSync, clock: StoreClock, dir: string) {
    this.#db = db;
    this.#lock = lock;
    this.#clock = clock;
    this.#dir = dir;
  }

  /** Records a run as running, with every operation pending, in one transaction; gives the new run's id. */
  begin(run: NewRun): Opened<string> {
    // Checked before it is written: one row the view cannot parse would make the whole history unreadable.
    const { id, startedAt } = Run.parse({
      ...run,
      id: this.#clock.newRunId(),
      status: 'running',
      startedAt: this.#clock.now().toISOString(),
      endedAt: null,
      undoneBy: null,
      operations: run.operations.map((operation) => Object.assign({ status: 'pending' }, operation)),
    });
    try {
      this.#insert(id, startedAt, run);
    } catch (error) {
      return { ok: false, refusal: refusalFor(error, this.#dir, runsPath(this.#dir)) };
    }
    return { ok: true, value: id };
  }

  #insert(id: string, startedAt: string, run: NewRun): void {
    transaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO runs (id, kind, action, subject, status, startedAt, undoes, planHash, generatedFrom)
           VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
        )
        .run(
          id,
          run.kind,
          run.action,
          run.subject,
          startedAt,
          run.undoes,
          run.planHash,
          JSON.stringify(run.generatedFrom),
        );
      const operation = this.#db.prepare(`INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`);
      for (const [position, { kind, path, beforeHash, afterHash, entries }] of run.operations.entries()) {
        operation.run(
          id,
          position,
          kind,
          path,
          beforeHash,
          afterHash,
          entries === null ? null : JSON.stringify(entries),
        );
      }
    });
  }

  /** Releases the store. */
  close(): void {
    try {
      this.#db.close();
    } finally {
      this.#lock.close();
    }
  }
}

// Held until close; it stays an empty database, and a reader probes it to learn whether a run is still running.
const takeLock = (dir: string): Opened<DatabaseSync> => {
  let lock: DatabaseSync | undefined;
  try {
    writable(lockPath(dir));
    lock = new DatabaseSync(lockPath(dir), { timeout: WAIT_MS });
    lock.exec('BEGIN EXCLUSIVE');
    return { ok: true, value: lock };
  } catch (error) {
    lock?.close();
    return { ok: false, refusal: refusalFor(error, dir, lockPath(dir)) };
  }
};

/**
 * Opens the run store in `dir`, the project's store folder (storeDir), a new folder private; refuses with store.locked
 * after a second's wait for another process.
 */
export const openStore = (dir: string, clock: StoreClock): Opened<RunStore> => {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, refusal: unreadable(error, dir) };
  }
  const taken = takeLock(dir);
  if (!taken.ok) return taken;
  const lock = taken.value;
  try {
    writable(runsPath(dir));
    const db = connectWriter(runsPath(dir));
    if (!db.ok) lock.close();
    return db.ok ? { ok: true, value: new RunStore(db.value, lock, clock, dir) } : db;
  } catch (error) {
    lock.close();
    return { ok: false, refusal: refusalFor(error, dir, runsPath(dir)) };
  }
};

type Row = Record<string, SQLOutputValue>;

// One read transaction, so a run and its operations come from the same commit.
const snapshot = <T>(db: DatabaseSync, read: () => T): T => {
  db.exec('BEGIN');
  try {
    return read();
  } finally {
    // SQLite ends the transaction by itself on some errors; a COMMIT then would hide the cause.
    if (db.isTransaction) db.exec('COMMIT');
  }
};

// Whether another connection holds the store lock; otherwise the read transaction it starts stays open until close.
const heldElsewhere = (lock: DatabaseSync): boolean => {
  try {
    lock.exec('BEGIN; SELECT count(*) FROM sqlite_master');
    return false;
  } catch (error) {
    if (resultCode(error) !== BUSY) throw error;
    return true;
  }
};

const parsedJson = (value: SQLOutputValue | undefined): unknown =>
  typeof value === 'string' ? JSON.parse(value) : value;

/** Read access to the run store that cannot write; it shares the store lock only during a read, so it works while a change runs. */
export class RunView {
  readonly #db: DatabaseSync | null;
  readonly #dir: string;

  constructor(db: DatabaseSync | null, dir: string) {
    this.#db = db;
    this.#dir = dir;
  }

  /** The runs, newest first; a run still marked running while no process holds the store was interrupted. */
  runs(): Opened<RunSummary[]> {
    const db = this.#db;
    if (db === null) return { ok: true, value: [] };
    return this.#probe(db, (held) =>
      db
        .prepare(`SELECT ${SUMMARY_COLUMNS} FROM runs r ORDER BY r.startedAt DESC, r.rowid DESC`)
        .all()
        .map((row) => RunSummary.parse(this.#current(row, held))),
    );
  }

  /** The run with this id and its operations, or undefined when the store has none. */
  run(id: string): Opened<Run | undefined> {
    const db = this.#db;
    if (db === null) return { ok: true, value: undefined };
    return this.#probe(db, (held) => {
      const row = db
        .prepare(`SELECT ${SUMMARY_COLUMNS}, r.planHash, r.generatedFrom FROM runs r WHERE r.id = ?`)
        .get(id);
      if (row === undefined) return undefined;
      const operations = db
        .prepare(
          'SELECT kind, path, beforeHash, afterHash, status, entries FROM operations WHERE runId = ? ORDER BY position',
        )
        .all(id)
        .map((operation) => Object.assign(operation, { entries: parsedJson(operation['entries']) }));
      return Run.parse({ ...this.#current(row, held), generatedFrom: parsedJson(row['generatedFrom']), operations });
    });
  }

  close(): void {
    this.#db?.close();
  }

  #current(row: Row, held: boolean): Row {
    return row['status'] === 'running' && !held ? { ...row, status: 'interrupted' } : row;
  }

  // Runs `read` with whether a process holds the store; the shared lock meanwhile keeps a change from starting in between.
  #probe<T>(db: DatabaseSync, read: (held: boolean) => T): Opened<T> {
    let file = lockPath(this.#dir);
    let lock: DatabaseSync | undefined;
    try {
      lock = existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : undefined;
      const held = lock !== undefined && heldElsewhere(lock);
      file = runsPath(this.#dir);
      return { ok: true, value: snapshot(db, () => read(held)) };
    } catch (error) {
      return { ok: false, refusal: readRefusal(error, file) };
    } finally {
      lock?.close();
    }
  }
}

/**
 * Opens the run store in `dir`, the project's store folder (storeDir), for reading; a store missing at open reads as
 * no runs for the view's life, and nothing is created.
 */
export const openRunView = (dir: string): Opened<RunView> => {
  const path = runsPath(dir);
  if (!existsSync(path)) return { ok: true, value: new RunView(null, dir) };
  let db: DatabaseSync | undefined;
  try {
    db = connectReader(path);
    const found = pragma(db, 'user_version');
    if (found === VERSION) return { ok: true, value: new RunView(db, dir) };
    db.close();
    // Version 0: a writer created the file and has not committed the schema yet, so no run was recorded.
    return found === 0 ? { ok: true, value: new RunView(null, dir) } : { ok: false, refusal: versionRefusal(found) };
  } catch (error) {
    db?.close();
    return { ok: false, refusal: readRefusal(error, path) };
  }
};
