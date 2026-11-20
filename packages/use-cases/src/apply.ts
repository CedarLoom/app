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
  entryAt,
  hashAt,
  linkIn,
  makeFolders,
  makesHardLinks,
  putBack,
  readFound,
  setAside,
  sha256,
  tempPath,
  writeNew,
} from './project-files.ts';
import { recover, unsettledBy } from './recover.ts';
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
  /** What a recovery right before, on the same held store, reported; the apply's findings start with it. */
  earlier?: Finding[];
}

export interface Applied {
  /** The run's id once it is recorded, also when it failed; null when nothing was recorded. */
  run: string | null;
  refusal: Refusal | null;
  /** apply.recovered for each file an interrupted run left and this apply settled first, recovery.skipped for each it could not. */
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

// RunId allows 64 characters.
const LONGEST_RUN_ID = 'r'.repeat(64);
// UTF-8 bytes, also of the decomposed form: never fewer than the bytes or UTF-16 units any volume counts.
const size = (text: string): number => Math.max(Buffer.byteLength(text), Buffer.byteLength(text.normalize('NFD')));
// NAME_MAX of Linux and macOS, and the usual component limit of Windows volumes.
const NAME_MAX = 255;
// PATH_MAX of Linux and macOS, and MAX_PATH of Windows and any other platform, each with the terminating NUL.
const PATH_MAX =
  new Map<string, number>([
    ['linux', 4096],
    ['darwin', 1024],
  ]).get(process.platform) ?? 260;
// Every folder of the path and the step's longest name beside it, and the whole path of that name.
const nameProblem = (root: string, path: string, position: number): Refusal | undefined => {
  const aside = join(root, asidePath(path, LONGEST_RUN_ID, position));
  const names = [...path.split('/').slice(0, -1), basename(aside)];
  return size(aside) >= PATH_MAX || names.some((name) => size(name) > NAME_MAX)
    ? refusal('plan.name-too-long', path)
    : undefined;
};

// The folders of a path, as keys: ".claude/a/b.md" has ".claude" and ".claude/a".
const folderKeys = (path: string): string[] => {
  const parts = fileKey(path).split('/');
  return parts.slice(1).map((_, end) => parts.slice(0, end + 1).join('/'));
};

// What the plan alone shows wrong with an operation; a plan path that is a folder of another one would make a step
// throw after the steps before it wrote.
const planProblem = (root: string, op: PlanOperation, position: number, nested: boolean): Refusal | undefined =>
  nameProblem(root, op.path, position) ?? (nested ? refusal('plan.path-nested', op.path) : textProblem(op));

// Every operation is checked before the first write, each against what the ones before it leave: one problem writes none.
export const precheck = (root: string, operations: readonly PlanOperation[]): Refusal | undefined => {
  const leaves = new Map<string, string | null>();
  const folders = new Set<string>();
  for (const [position, op] of operations.entries()) {
    if (!inWriteRoots(op.path)) return refusal('plan.path-outside-roots', op.path);
    const key = fileKey(op.path);
    const above = folderKeys(op.path);
    const nested = folders.has(key) || above.some((folder) => leaves.has(folder));
    const problem =
      planProblem(root, op, position, nested) ??
      linkRefusal(root, op.path) ??
      (leaves.has(key) ? chainProblem(op, leaves.get(key)) : diskProblem(root, op));
    if (problem !== undefined) return problem;
    leaves.set(key, op.afterHash);
    for (const folder of above) folders.add(folder);
  }
  return undefined;
};

// A step that links a new file in on a volume without hard links would stop after it set the old file aside; each
// volume is probed once, in the deepest folder of a plan path that exists, as the precheck found no link on its way.
const linksProblem = (root: string, operations: readonly PlanOperation[]): Refusal | undefined => {
  const probed = new Set<bigint>();
  for (const op of operations) {
    if (op.after === null) continue;
    let folder = dirname(join(root, op.path));
    let entry = entryAt(folder);
    for (; entry === undefined; entry = entryAt(folder)) folder = dirname(folder);
    if (probed.has(entry.dev)) continue;
    probed.add(entry.dev);
    if (!makesHardLinks(folder)) return refusal('apply.no-hard-links', op.path);
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
    else if (aside !== null) putBack(aside, path);
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
  return undefined;
};

/** What a step's exception becomes: the run it stopped, what the recoveries around it reported, and the cause. */
export class StepFailed extends Error {
  readonly run: string;
  readonly findings: Finding[];

  constructor(run: string, findings: Finding[], cause: unknown) {
    super(`run ${run} stopped: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.run = run;
    this.findings = findings;
  }
}

// What recovery reports once a step threw, and the cause: the step's own error, kept first when recovery fails too.
const afterRecovery = (store: RunStore, root: string, error: unknown): { findings: Finding[]; cause: unknown } => {
  try {
    return { findings: recover(store, root), cause: error };
  } catch (failure) {
    return {
      findings: [],
      cause: new AggregateError([error, failure], 'a step failed, and the recovery after it failed too'),
    };
  }
};

const journal = ({ before: _before, after: _after, ...hashes }: PlanOperation): NewRun['operations'][number] => ({
  ...hashes,
  entries: null,
});

// Writes each step in order and ends the run with its last one: null when every step is done, else the step's refusal.
const steps = (context: Step, operations: readonly PlanOperation[]): Refusal | null => {
  const { store, run } = context;
  const last = operations.length - 1;
  for (const [position, op] of operations.entries()) {
    const stopped = step(context, position, op);
    if (stopped !== undefined) {
      store.finish(run, 'failed', [position, 'failed']);
      return stopped;
    }
    if (position < last) store.settle(run, position, 'done');
  }
  store.finish(run, 'done', [last, 'done']);
  return null;
};

/**
 * Applies a plan as one run on the held store: settles what interrupted runs left, refuses while one is unsettled,
 * checks every operation and that the volume makes hard links, then writes each one crash-ordered and stops at the first that fails. An empty plan records
 * no run. `at` runs at each boundary. A step that throws ends the run, or leaves it to a later recovery as the
 * findings of StepFailed report, and throws StepFailed.
 */
export const apply = (store: RunStore, request: ApplyRequest, at: At = () => undefined): Applied => {
  const { root, plan, run, earlier = [] } = request;
  const findings = [...earlier, ...recover(store, root)];
  const { operations } = plan;
  if (operations.length === 0) return { run: null, refusal: null, findings };
  const problem = unsettledBy(findings) ?? precheck(root, operations) ?? linksProblem(root, operations);
  if (problem !== undefined) return { run: null, refusal: problem, findings };
  const begun = store.begin({ ...run, planHash: plan.planHash, operations: operations.map(journal) });
  if (!begun.ok) return { run: null, refusal: begun.refusal, findings };
  try {
    return { run: begun.value, refusal: steps({ store, run: begun.value, root, at }, operations), findings };
  } catch (error) {
    // Settled now where the filesystem allows, so the run is not listed as running while this process holds the store.
    const after = afterRecovery(store, root, error);
    throw new StepFailed(begun.value, [...findings, ...after.findings], after.cause);
  }
};
