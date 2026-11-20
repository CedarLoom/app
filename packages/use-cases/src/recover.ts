import { rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, Refusal, Run } from '@cedarloom/core';
import { asidePath, entryAt, errorCode, hashAt, putBack, tempPath } from './project-files.ts';
import type { RunStore } from './store.ts';
import { linkOnWay } from './write-roots.ts';

export type Operation = Run['operations'][number];

// Back when the path is empty; gone when the path is the aside itself or the aside is the old file, which the step
// backed up first; else both stay, as the aside is another process's file.
const settleAside = (path: string, aside: string, op: Operation): void => {
  const moved = entryAt(aside);
  if (moved === undefined) return;
  const target = entryAt(path);
  if (target === undefined) return putBack(aside, path);
  const same = target.dev === moved.dev && target.ino === moved.ino;
  if (same || hashAt(aside) === op.beforeHash) unlinkSync(aside);
};

interface Unsettled {
  store: RunStore;
  root: string;
  run: string;
}

// Removes the step's temporary files and settles its aside; true when the step had started.
const settleStep = ({ store, root, run }: Unsettled, position: number, op: Operation): boolean => {
  const path = join(root, op.path);
  const temp = tempPath(path, run, position);
  const aside = asidePath(path, run, position);
  const tempLeft = entryAt(temp) !== undefined;
  // A path too long to exist holds nothing, so its step never started.
  const started =
    tempLeft || entryAt(aside) !== undefined || (entryAt(path) === undefined ? null : hashAt(path)) === op.afterHash;
  // rmSync throws for a name that cannot exist, also with force.
  if (tempLeft) rmSync(temp, { force: true });
  rmSync(`${store.backupPath(run, position)}.tmp`, { force: true });
  settleAside(path, aside, op);
  return started;
};

// The codes of a filesystem that refuses a change for now: no permission, a read-only volume, a file another process holds.
const REFUSED = new Set(['EACCES', 'EPERM', 'EROFS', 'EBUSY']);

// Whether the step's files were put in order: undefined when a link is on the way since the run, so nothing is moved
// through it, or when the filesystem refused, as in a folder this user may not enter or write.
const settled = (unsettled: Unsettled, position: number, op: Operation): boolean | undefined => {
  try {
    if (linkOnWay(unsettled.root, op.path) !== undefined) return undefined;
    return settleStep(unsettled, position, op);
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
 * in order and its path reported as apply.recovered, and the run stays listed as interrupted. A step a link or a
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
    const started = settled({ store, root, run }, position, op);
    const params = { run, path: op.path };
    if (started === undefined) {
      findings.push({ code: 'recovery.skipped', severity: 'warning', params });
      continue;
    }
    if (started) findings.push({ code: 'apply.recovered', severity: 'info', params });
    store.finish(run, 'interrupted', started ? [position, 'settled'] : undefined);
  }
  return findings;
};
