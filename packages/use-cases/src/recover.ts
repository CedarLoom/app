import { rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, Refusal, Run } from '@cedarloom/core';
import { asidePath, entryAt, errorCode, hashAt, putBack, tempPath } from './project-files.ts';
import type { RunStore } from './store.ts';
import { linkOnWay } from './write-roots.ts';

export type Operation = Run['operations'][number];

// Back when the path is empty; gone when the path is the aside itself or the aside is the old file, which the step
// backed up first; else both stay, as the aside is another process's file. True when the old file went.
const settleAside = (path: string, aside: string, op: Operation): boolean => {
  const moved = entryAt(aside);
  if (moved === undefined) return false;
  const target = entryAt(path);
  if (target === undefined) {
    putBack(aside, path);
    return false;
  }
  const same = target.dev === moved.dev && target.ino === moved.ino;
  const old = !same && hashAt(aside) === op.beforeHash;
  if (same || old) unlinkSync(aside);
  return old;
};

type Ended = 'settled' | 'untouched';

// The hash of the file at a path, null for nothing; a path too long to exist holds nothing.
const resultAt = (path: string): string | null => (entryAt(path) === undefined ? null : hashAt(path));

interface Unsettled {
  store: RunStore;
  root: string;
  run: string;
}

// Removes the step's temporary files and settles its aside; how a started step ended, undefined for one never started.
const settleStep = ({ store, root, run }: Unsettled, position: number, op: Operation): Ended | undefined => {
  const path = join(root, op.path);
  const temp = tempPath(path, run, position);
  const aside = asidePath(path, run, position);
  const tempLeft = entryAt(temp) !== undefined;
  const started = tempLeft || entryAt(aside) !== undefined || resultAt(path) === op.afterHash;
  // rmSync throws for a name that cannot exist, also with force.
  if (tempLeft) rmSync(temp, { force: true });
  rmSync(`${store.backupPath(run, position)}.tmp`, { force: true });
  const dropped = settleAside(path, aside, op);
  if (!started) return undefined;
  // The old file goes only after the temporary file, so a step that neither dropped it nor left its result changed nothing.
  return dropped || resultAt(path) === op.afterHash ? 'settled' : 'untouched';
};

// The codes of a filesystem that refuses a change for now: no permission, a read-only volume, a file another process holds.
const REFUSED = new Set(['EACCES', 'EPERM', 'EROFS', 'EBUSY']);

// How the step ended once its files were put in order, null when it never started: undefined when a link is on the way
// since the run, so nothing is moved through it, or when the filesystem refused, as in a folder this user may not enter
// or write.
const settled = (unsettled: Unsettled, position: number, op: Operation): Ended | null | undefined => {
  try {
    if (linkOnWay(unsettled.root, op.path) !== undefined) return undefined;
    return settleStep(unsettled, position, op) ?? null;
  } catch (error) {
    if (REFUSED.has(String(errorCode(error)))) return undefined;
    throw error;
  }
};

/** The refusal of any change while a run the recovery skipped is unsettled, as its files may lie on the change's paths. */
export const unsettledBy = (findings: Finding[]): Refusal | undefined => {
  const skipped = findings.find((finding) => finding.code === 'recovery.skipped');
  return skipped && { code: 'apply.unsettled', params: skipped.params };
};

/**
 * Settles the steps of runs whose process stopped without an end, on the held store: a started step's files are put
 * in order, it is journaled as settled or as untouched when it never changed its path, its path is reported as
 * apply.recovered, and the run stays listed as interrupted. A step a link or a
 * refusing filesystem keeps from being settled is reported as recovery.skipped, and its run stays running for a later
 * recovery; any other error propagates. Idempotent.
 */
export const recover = (store: RunStore, root: string): Finding[] => {
  const findings: Finding[] = [];
  for (const { run, operations } of store.unfinished()) {
    // Steps run in order and each is journaled as it ends, so only the first pending one can have started.
    const position = operations.findIndex((op) => op.status === 'pending');
    const op = operations[position];
    // Nothing to settle: a run without operations, such as an undo that restores nothing, or with every step journaled.
    if (op === undefined) {
      store.finish(run, 'interrupted');
      continue;
    }
    const ended = settled({ store, root, run }, position, op);
    const params = { run, path: op.path };
    if (ended === undefined) {
      findings.push({ code: 'recovery.skipped', severity: 'warning', params });
      continue;
    }
    if (ended !== null) findings.push({ code: 'apply.recovered', severity: 'info', params });
    store.finish(run, 'interrupted', ended === null ? undefined : [position, ended]);
  }
  return findings;
};
