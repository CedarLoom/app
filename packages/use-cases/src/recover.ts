import { rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, Run } from '@cedarloom/core';
import { asidePath, entryAt, hashAt, putBack, tempPath } from './project-files.ts';
import type { RunStore } from './store.ts';
import { linkOnWay } from './write-roots.ts';

type Operation = Run['operations'][number];

// Back when the path is empty; gone when the path is the aside itself or the aside is the old file, which the step
// backed up first; else both stay, as the aside is another process's file.
const settleAside = (path: string, aside: string, op: Operation): void => {
  const moved = entryAt(aside);
  if (moved === undefined) return;
  const target = entryAt(path);
  if (target === undefined) return putBack(aside, path, moved.isFile());
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
  const started = tempLeft || entryAt(aside) !== undefined || hashAt(path) === op.afterHash;
  // rmSync throws for a name that cannot exist, also with force.
  if (tempLeft) rmSync(temp, { force: true });
  rmSync(`${store.backupPath(run, position)}.tmp`, { force: true });
  settleAside(path, aside, op);
  return started;
};

/**
 * Settles the steps of runs whose process stopped without an end, on the held store: a started step's files are put
 * in order and its path reported as apply.recovered, and the run stays listed as interrupted. Idempotent.
 */
export const recover = (store: RunStore, root: string): Finding[] => {
  const findings: Finding[] = [];
  for (const { run, operations } of store.unfinished()) {
    // Steps run in order and each is journaled as it ends, so only the first pending one can have started.
    const position = operations.findIndex((op) => op.status === 'pending');
    const op = operations[position];
    // A link on the way since the run: nothing is moved through it, and the run stays running for a later recovery.
    if (op !== undefined && linkOnWay(root, op.path) !== undefined) continue;
    if (op !== undefined && settleStep({ store, root, run }, position, op)) {
      store.settle(run, position, 'settled');
      findings.push({ code: 'apply.recovered', severity: 'info', params: { run, path: op.path } });
    }
    store.finish(run, 'interrupted');
  }
  return findings;
};
