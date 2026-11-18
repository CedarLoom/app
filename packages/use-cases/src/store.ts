import { existsSync, mkdirSync } from 'node:fs';
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
PRAGMA user_version = ${VERSION};
`;

const SUMMARY_COLUMNS = `r.id, r.kind, r.action, r.subject, r.status, r.startedAt, r.endedAt, r.undoes,
  (SELECT u.id FROM runs u WHERE u.undoes = r.id AND u.status = 'done') AS undoneBy`;

/** What a use case gets from the store: the value, or the refusal that stops it. */
export type Opened<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

/** A run as its use case starts it; the store adds the id, the status, the times and each operation's status. */
export type NewRun = Pick<Run, 'kind' | 'action' | 'subject' | 'undoes' | 'planHash' | 'generatedFrom'> & {
  operations: Omit<Run['operations'][number], 'status'>[];
};

/** The time and the run ids a store uses. */
export interface StoreClock {
  now: () => Date;
  newRunId: () => string;
}

const runsPath = (dir: string): string => join(dir, 'runs.sqlite');
const lockPath = (dir: string): string => join(dir, 'lock.sqlite');

// SQLite's primary result codes, without the extended bits.
const BUSY = 5;
const UNREADABLE = new Set([11, 14, 26]); // SQLITE_CORRUPT, SQLITE_CANTOPEN, SQLITE_NOTADB

const resultCode = (error: unknown): number | undefined =>
  error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' ? error.errcode & 0xff : undefined;

// The refusal for a SQLite error about the store's own files; any other error propagates.
const refusalFor = (error: unknown, dir: string, file: string): Refusal => {
  const code = resultCode(error);
  if (code === BUSY) return { code: 'store.locked', params: { path: runsPath(dir) } };
  if (code !== undefined && UNREADABLE.has(code)) return { code: 'store.unreadable', params: { path: file } };
  throw error;
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

// Durable before anything is written: WAL with a sync at each commit, both read back, since SQLite keeps another
// journal mode without an error where the filesystem cannot share memory.
const durable = (db: DatabaseSync): void => {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON');
  const journal = pragma(db, 'journal_mode');
  const synchronous = pragma(db, 'synchronous');
  if (journal !== 'wal' || synchronous !== 2) {
    throw new Error(`the store runs with journal_mode ${String(journal)} and synchronous ${String(synchronous)}`);
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

  constructor(db: DatabaseSync, lock: DatabaseSync, clock: StoreClock) {
    this.#db = db;
    this.#lock = lock;
    this.#clock = clock;
  }

  /** Records a run as running, with every operation pending, in one transaction; returns the new run's id. */
  begin(run: NewRun): string {
    const id = this.#clock.newRunId();
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
          this.#clock.now().toISOString(),
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
    return id;
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

/**
 * Opens the run store in `dir`, creating the folder private: waits up to a second while another process holds it,
 * then refuses with store.locked; refuses a store of another version or one SQLite cannot read.
 */
export const openStore = (dir: string, clock: StoreClock): Opened<RunStore> => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Held until close; it stays an empty database, and a reader probes it to learn whether a run is still running.
  const lock = new DatabaseSync(lockPath(dir), { timeout: WAIT_MS });
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    return { ok: false, refusal: refusalFor(error, dir, lockPath(dir)) };
  }
  try {
    const db = connectWriter(runsPath(dir));
    if (!db.ok) lock.close();
    return db.ok ? { ok: true, value: new RunStore(db.value, lock, clock) } : db;
  } catch (error) {
    lock.close();
    return { ok: false, refusal: refusalFor(error, dir, runsPath(dir)) };
  }
};

type Row = Record<string, SQLOutputValue>;

const parsedJson = (value: SQLOutputValue | undefined): unknown =>
  typeof value === 'string' ? JSON.parse(value) : value;

/** Read access to the run store: takes no store lock and cannot write, so it works while a change runs. */
export class RunView {
  readonly #db: DatabaseSync | null;
  readonly #lock: string;

  constructor(db: DatabaseSync | null, lock: string) {
    this.#db = db;
    this.#lock = lock;
  }

  /** The runs, newest first; a run still marked running while no process holds the store was interrupted. */
  runs(): RunSummary[] {
    const db = this.#db;
    if (db === null) return [];
    return this.#probe((held) =>
      db
        .prepare(`SELECT ${SUMMARY_COLUMNS} FROM runs r ORDER BY r.startedAt DESC, r.rowid DESC`)
        .all()
        .map((row) => RunSummary.parse(this.#current(row, held))),
    );
  }

  /** The run with this id and its operations, or undefined when the store has none. */
  run(id: string): Run | undefined {
    const db = this.#db;
    if (db === null) return undefined;
    return this.#probe((held) => {
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
  #probe<T>(read: (held: boolean) => T): T {
    if (!existsSync(this.#lock)) return read(false);
    const lock = new DatabaseSync(this.#lock, { readOnly: true });
    try {
      let held = false;
      try {
        lock.exec('BEGIN; SELECT count(*) FROM sqlite_master');
      } catch (error) {
        if (resultCode(error) !== BUSY) throw error;
        held = true;
      }
      return read(held);
    } finally {
      lock.close();
    }
  }
}

/**
 * Opens the run store in `dir` for reading. A missing store reads as one with no runs, and nothing is created;
 * a store of another version, or one SQLite cannot read, is refused.
 */
export const openRunView = (dir: string): Opened<RunView> => {
  const path = runsPath(dir);
  if (!existsSync(path)) return { ok: true, value: new RunView(null, lockPath(dir)) };
  const db = connectReader(path);
  try {
    const found = pragma(db, 'user_version');
    if (found === VERSION) return { ok: true, value: new RunView(db, lockPath(dir)) };
    db.close();
    // Version 0: a writer created the file and has not committed the schema yet, so no run was recorded.
    return found === 0
      ? { ok: true, value: new RunView(null, lockPath(dir)) }
      : { ok: false, refusal: versionRefusal(found) };
  } catch (error) {
    db.close();
    return { ok: false, refusal: refusalFor(error, dir, path) };
  }
};
