import { isUtf8 } from 'node:buffer';
import { rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Finding, PlanOperation, PlanPreview, Refusal } from '@cedarloom/core';
import {
  asidePath,
  Changed,
  copyAtomic,
  dropAside,
  errorCode,
  type Found,
  hashAt,
  linkIn,
  makeFolders,
  putBack,
  readFound,
  setAside,
  sha256,
  tempPath,
  writeNew,
} from './project-files.ts';
import { recover } from './recover.ts';
import type { NewRun, RunStore } from './store.ts';
import { inWriteRoots, linkOnWay } from './write-roots.ts';

/**
 * The points between the crash-ordered parts of one step: the new file written beside its target, the old file set
 * aside and checked, the new file linked in, the written file checked and only its journal entry left.
 */
export type Boundary = 'temp-written' | 'set-aside' | 'linked' | 'written';

export interface ApplyRequest {
  /** The project root, absolute; the plan's paths are relative to it. */
  root: string;
  plan: PlanPreview;
  run: Pick<NewRun, 'kind' | 'action' | 'subject' | 'undoes' | 'generatedFrom'>;
}

export interface Applied {
  /** The run's id once it is recorded, also when it failed; null when nothing was recorded. */
  run: string | null;
  refusal: Refusal | null;
  /** apply.recovered for each file an interrupted run left and this apply settled first. */
  findings: Finding[];
}

/** Runs at each boundary of each step. */
export type At = (boundary: Boundary, position: number) => void;

interface Step {
  store: RunStore;
  run: string;
  root: string;
  at: At;
}

export const refusal = (code: Refusal['code'], path: string): Refusal => ({ code, params: { path } });

export const linkRefusal = (root: string, path: string): Refusal | undefined => {
  const link = linkOnWay(root, path);
  return link === undefined ? undefined : refusal('plan.symlink', link);
};

// The file a step replaces or deletes, when it is the text file the plan expects.
const expected = (path: string, before: string, found: Found): Refusal | { bytes: Buffer; mode: number } => {
  if (found === 'link') return refusal('plan.symlink', path);
  if (found === 'not-file') return refusal('plan.not-text', path);
  if (found === 'absent' || sha256(found.bytes) !== before) return refusal('plan.file-changed', path);
  return isUtf8(found.bytes) ? found : refusal('plan.not-text', path);
};

const diskProblem = (root: string, { path, beforeHash }: PlanOperation): Refusal | undefined => {
  const found = readFound(join(root, path));
  if (beforeHash === null) return found === 'absent' ? undefined : refusal('plan.file-changed', path);
  const file = expected(path, beforeHash, found);
  return 'code' in file ? file : undefined;
};

// A later operation on a path starts from what the one before it leaves.
const chainProblem = (op: PlanOperation, left: string | null | undefined): Refusal | undefined =>
  op.beforeHash === left ? undefined : refusal('plan.file-changed', op.path);

// Paths macOS and Windows may read as one file chain as one; elsewhere two such paths are refused, never half written.
export const fileKey = (path: string): string => path.normalize('NFC').toLowerCase();

// The text a step writes is the one its hash names, so the check after the write cannot fail once the old file went.
const textProblem = ({ path, after, afterHash }: PlanOperation): Refusal | undefined =>
  after === null || sha256(Buffer.from(after)) === afterHash ? undefined : refusal('plan.text-mismatch', path);

// RunId allows 64 characters, and most filesystems 255 bytes in a name.
const LONGEST_RUN_ID = 'r'.repeat(64);
const nameProblem = (path: string, position: number): Refusal | undefined =>
  Buffer.byteLength(basename(asidePath(path, LONGEST_RUN_ID, position))) > 255
    ? refusal('plan.name-too-long', path)
    : undefined;

// The folders of a path, as keys: ".claude/a/b.md" has ".claude" and ".claude/a".
const folderKeys = (path: string): string[] => {
  const parts = fileKey(path).split('/');
  return parts.slice(1).map((_, end) => parts.slice(0, end + 1).join('/'));
};

// What the plan alone shows wrong with an operation; a plan path that is a folder of another one would make a step
// throw after the steps before it wrote.
const planProblem = (op: PlanOperation, position: number, nested: boolean): Refusal | undefined =>
  nameProblem(op.path, position) ?? (nested ? refusal('plan.file-changed', op.path) : textProblem(op));

// Every operation is checked before the first write, each against what the ones before it leave: one problem writes none.
const precheck = (root: string, operations: readonly PlanOperation[]): Refusal | undefined => {
  const leaves = new Map<string, string | null>();
  const folders = new Set<string>();
  for (const [position, op] of operations.entries()) {
    if (!inWriteRoots(op.path)) return refusal('plan.path-outside-roots', op.path);
    const key = fileKey(op.path);
    const above = folderKeys(op.path);
    const nested = folders.has(key) || above.some((folder) => leaves.has(folder));
    const problem =
      planProblem(op, position, nested) ??
      linkRefusal(root, op.path) ??
      (leaves.has(key) ? chainProblem(op, leaves.get(key)) : diskProblem(root, op));
    if (problem !== undefined) return problem;
    leaves.set(key, op.afterHash);
    for (const folder of above) folders.add(folder);
  }
  return undefined;
};

// The copy undo restores from, read back before the step may write.
const backUp = (bytes: Buffer, dest: string): boolean => {
  try {
    copyAtomic(bytes, dest);
    return hashAt(dest) === sha256(bytes);
  } catch (error) {
    if (errorCode(error) !== undefined) return false;
    throw error;
  }
};

// Another process's new file at the path stays, and the old one, checked and backed up, goes.
const linkNew = (temp: string, path: string, aside: string | null): void => {
  try {
    linkIn(temp, path);
  } catch (error) {
    if (aside !== null && error instanceof Changed) dropAside(aside);
    else if (aside !== null) putBack(aside, path, true);
    throw error;
  }
};

// Write beside, set the old file aside and check it, link the new one in, drop the old one; no temporary file stays.
const change = ({ run, root, at }: Step, position: number, op: PlanOperation, mode?: number): void => {
  const path = join(root, op.path);
  const temp = tempPath(path, run, position);
  const aside = asidePath(path, run, position);
  try {
    if (op.after !== null) {
      writeNew(temp, Buffer.from(op.after), mode);
      at('temp-written', position);
    }
    if (op.beforeHash !== null) {
      setAside(path, aside, op.beforeHash);
      at('set-aside', position);
    }
    if (op.after !== null) {
      linkNew(temp, path, op.beforeHash === null ? null : aside);
      at('linked', position);
    }
    if (op.beforeHash !== null) dropAside(aside);
  } finally {
    rmSync(temp, { force: true });
  }
};

// Re-checked before the missing folders are made, which would follow a link, and again right before the write.
const step = (context: Step, position: number, op: PlanOperation): Refusal | undefined => {
  const { store, run, root, at } = context;
  const path = join(root, op.path);
  const linked = linkRefusal(root, op.path);
  if (linked !== undefined) return linked;
  let mode: number | undefined;
  if (op.beforeHash !== null) {
    const file = expected(op.path, op.beforeHash, readFound(path));
    if ('code' in file) return file;
    if (!backUp(file.bytes, store.backupPath(run, position))) {
      return { code: 'apply.backup-failed', params: { run, path: op.path } };
    }
    mode = file.mode;
  }
  makeFolders(dirname(path));
  const relinked = linkRefusal(root, op.path);
  if (relinked !== undefined) return relinked;
  try {
    change(context, position, op, mode);
  } catch (error) {
    if (error instanceof Changed) return refusal('plan.file-changed', op.path);
    throw error;
  }
  if (hashAt(path) !== op.afterHash) return { code: 'apply.write-mismatch', params: { run, path: op.path } };
  at('written', position);
  store.settle(run, position, 'done');
  return undefined;
};

// What a step's exception becomes once recovery ran: the step's own error, kept first when recovery fails too.
const afterRecovery = (store: RunStore, root: string, error: unknown): unknown => {
  try {
    recover(store, root);
  } catch (failure) {
    return new AggregateError([error, failure], 'a step failed, and the recovery after it failed too');
  }
  return error;
};

const journal = ({ before: _before, after: _after, ...hashes }: PlanOperation): NewRun['operations'][number] => ({
  ...hashes,
  entries: null,
});

/**
 * Applies a plan as one run on the held store: settles what interrupted runs left, checks every operation, then writes
 * each one crash-ordered and stops at the first that fails. An empty plan records no run. `at` runs at each boundary.
 */
export const apply = (store: RunStore, { root, plan, run }: ApplyRequest, at: At = () => undefined): Applied => {
  const findings = recover(store, root);
  const { operations } = plan;
  if (operations.length === 0) return { run: null, refusal: null, findings };
  const problem = precheck(root, operations);
  if (problem !== undefined) return { run: null, refusal: problem, findings };
  const begun = store.begin({ ...run, planHash: plan.planHash, operations: operations.map(journal) });
  if (!begun.ok) return { run: null, refusal: begun.refusal, findings };
  const id = begun.value;
  for (const [position, op] of operations.entries()) {
    let stopped: Refusal | undefined;
    try {
      stopped = step({ store, run: id, root, at }, position, op);
    } catch (error) {
      // Settled now, so the run is not listed as running while this process holds the store.
      throw afterRecovery(store, root, error);
    }
    if (stopped !== undefined) {
      store.settle(id, position, 'failed');
      store.finish(id, 'failed');
      return { run: id, refusal: stopped, findings };
    }
  }
  store.finish(id, 'done');
  return { run: id, refusal: null, findings };
};
