import { isUtf8 } from 'node:buffer';
import { lstatSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Finding, PlanOperation, PlanPreview, Refusal, SettingsEntry } from '@cedarloom/core';
import {
  asidePath,
  Changed,
  copyAtomic,
  dropAside,
  errorCode,
  entryAt,
  FILE_LIMIT,
  type FileFound,
  fileAt,
  hashAt,
  linkIn,
  makeFolders,
  makesHardLinks,
  putBack,
  readsAsOne,
  setAside,
  sha256,
  tempPath,
  writeNew,
} from './project-files.ts';
import { reached } from './plugin-folder.ts';
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
  /** The permission bits of the file each create writes, by its position in the plan; a new file's default otherwise. */
  modes?: ReadonlyMap<number, number>;
  /** The settings entries each operation writes or removes, by its position in the plan; none otherwise. */
  entries?: ReadonlyMap<number, SettingsEntry[]>;
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
  modes: ReadonlyMap<number, number>;
}

/** A step that stopped: its refusal, and whether it changed its path before. */
interface Stop {
  refusal: Refusal;
  end: 'failed' | 'untouched';
}

const untouched = (stop: Refusal): Stop => ({ refusal: stop, end: 'untouched' });

/** Another process's file took the path after the step dropped the old one. */
class Dropped extends Changed {}

export const refusal = (code: Refusal['code'], path: string): Refusal => ({ code, params: { path } });

// A folder on the way that the app may not enter hides whether a link is below it.
export const linkRefusal = (root: string, path: string): Refusal | undefined => {
  const link = reached(() => linkOnWay(root, path) ?? null);
  if (link === undefined) return refusal('plan.folder-denied', path);
  return link === null ? undefined : refusal('plan.symlink', link);
};

// The file a step replaces or deletes, when it is the text file the plan expects.
const expected = (path: string, before: string, found: FileFound): Refusal | { bytes: Buffer; mode: number } => {
  if (found === 'link') return refusal('plan.symlink', path);
  if (found === 'not-file' || found === 'too-large') return refusal('plan.not-text', path);
  if (found === 'absent' || sha256(found.bytes) !== before) return refusal('plan.file-changed', path);
  return isUtf8(found.bytes) ? found : refusal('plan.not-text', path);
};

const diskProblem = (root: string, { path, beforeHash }: PlanOperation): Refusal | undefined => {
  const found = fileAt(join(root, path));
  if (beforeHash === null) return found === 'absent' ? undefined : refusal('plan.file-changed', path);
  const file = expected(path, beforeHash, found);
  return 'code' in file ? file : undefined;
};

// Two spellings are one file where they reach one existing folder and a probe there reads the rest as one file.
const sameFile = (root: string, first: string, path: string): boolean => {
  if (first === path) return true;
  const [a, b] = [first.split('/'), path.split('/')];
  let depth = a.length - 1;
  while (depth > 0 && entryAt(join(root, ...a.slice(0, depth))) === undefined) depth -= 1;
  const folder = join(root, ...a.slice(0, depth));
  const [one, two] = [entryAt(folder), entryAt(join(root, ...b.slice(0, depth)))];
  if (one === undefined || two === undefined || one.dev !== two.dev || one.ino !== two.ino) return false;
  const [rest, otherRest] = [a.slice(depth).join('/'), b.slice(depth).join('/')];
  return rest === otherRest || readsAsOne(folder, rest, otherRest);
};

/** The operations on one file so far: the path the first one named, and the hash the last one leaves. */
interface Chain {
  first: string;
  left: string | null;
}

// A read or a probe the app may not make: EACCES, or EPERM, as Windows reports a denied access.
const DENIED = new Set<unknown>(['EACCES', 'EPERM']);
const orDenied = <T>(path: string, act: () => T): T | Refusal => {
  try {
    return act();
  } catch (error) {
    if (DENIED.has(errorCode(error))) return refusal('plan.folder-denied', path);
    throw error;
  }
};

// A later operation on a path starts from what the one before it leaves, at the file the chain began with.
const chainProblem = (root: string, op: PlanOperation, { first, left }: Chain): Refusal | undefined =>
  op.beforeHash === left && sameFile(root, first, op.path) ? undefined : refusal('plan.file-changed', op.path);

// A folder on the way that is a file; Windows reads a path below it as absent, not as ENOTDIR.
export const fileOnWay = (root: string, path: string): Refusal | undefined => {
  const parts = path.split('/');
  for (let end = 1; end < parts.length; end += 1) {
    const entry = entryAt(join(root, ...parts.slice(0, end)));
    if (entry === undefined) return undefined;
    if (!entry.isDirectory()) return refusal('plan.path-through-file', path);
  }
  return undefined;
};

// Paths of one key chain where the volume reads them as one file, else are refused; other folds (ß, ss) get two keys.
export const fileKey = (path: string): string => path.normalize('NFC').toLowerCase();

// What the disk shows wrong with an operation, as the operations before it on the same file leave it.
const fileProblem = (root: string, op: PlanOperation, chain: Chain | undefined): Refusal | undefined =>
  linkRefusal(root, op.path) ??
  fileOnWay(root, op.path) ??
  (chain === undefined ? diskProblem(root, op) : chainProblem(root, op, chain));

// A text the step writes that its hash does not name, or that a later plan or undo would not read, fails after the write.
const textProblem = ({ path, after, afterHash }: PlanOperation): Refusal | undefined => {
  if (after === null) return undefined;
  const bytes = Buffer.from(after);
  if (sha256(bytes) !== afterHash) return refusal('plan.text-mismatch', path);
  return bytes.length > FILE_LIMIT ? refusal('plan.not-text', path) : undefined;
};

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
  const chains = new Map<string, Chain>();
  const folders = new Set<string>();
  for (const [position, op] of operations.entries()) {
    if (!inWriteRoots(op.path)) return refusal('plan.path-outside-roots', op.path);
    const key = fileKey(op.path);
    const above = folderKeys(op.path);
    const nested = folders.has(key) || above.some((folder) => chains.has(folder));
    const chain = chains.get(key);
    const problem = planProblem(root, op, position, nested) ?? orDenied(op.path, () => fileProblem(root, op, chain));
    if (problem !== undefined) return problem;
    chains.set(key, { first: chain?.first ?? op.path, left: op.afterHash });
    for (const folder of above) folders.add(folder);
  }
  return undefined;
};

// The folders of a plan path below the root: ".claude/a/b.md" has two.
const levels = (path: string): number => path.split('/').length - 1;

// The probe goes in the deepest folder that exists, the root at most, as the precheck found no link on its way.
const linksAt = (root: string, op: PlanOperation, probed: Set<bigint>): Refusal | undefined => {
  let folder = dirname(join(root, op.path));
  let entry = entryAt(folder);
  for (let up = levels(op.path); entry === undefined && up > 0; up -= 1, entry = entryAt(folder))
    folder = dirname(folder);
  // The root is absent where it was removed or its drive is gone; lstat then throws ENOENT.
  entry ??= lstatSync(folder, { bigint: true });
  if (probed.has(entry.dev)) return undefined;
  probed.add(entry.dev);
  return makesHardLinks(folder) ? undefined : refusal('apply.no-hard-links', op.path);
};

// A step on a volume without hard links would stop after it set the old file aside, and so would the undo of a delete.
const linksProblem = (root: string, operations: readonly PlanOperation[]): Refusal | undefined => {
  const probed = new Set<bigint>();
  for (const op of operations) {
    const problem = orDenied(op.path, () => linksAt(root, op, probed));
    if (problem !== undefined) return problem;
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
    if (aside !== null && error instanceof Changed) {
      // First, so recovery never reads a temporary file left as a step that kept the old file.
      dropAside(temp);
      dropAside(aside);
      throw new Dropped();
    }
    if (aside !== null) putBack(aside, path);
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
      // Before the old file, as on the race path.
      dropAside(temp);
    }
    if (op.beforeHash !== null) dropAside(aside);
  } catch (error) {
    // The temporary file goes next to a failed step too; where it cannot, the step's error stays first.
    try {
      rmSync(temp, { force: true });
    } catch (failure) {
      throw new AggregateError([error, failure], 'a step failed, and removing its temporary file failed too', {
        cause: failure,
      });
    }
    throw error;
  }
};

// The write of a step, and whether it changed the path when it stops.
const written = (context: Step, position: number, op: PlanOperation, mode: number | undefined): Stop | undefined => {
  try {
    change(context, position, op, mode);
  } catch (error) {
    if (!(error instanceof Changed)) throw error;
    return { refusal: refusal('plan.file-changed', op.path), end: error instanceof Dropped ? 'failed' : 'untouched' };
  }
  if (hashAt(join(context.root, op.path)) === op.afterHash) return undefined;
  return { refusal: { code: 'apply.write-mismatch', params: { run: context.run, path: op.path } }, end: 'failed' };
};

// Re-checked before the missing folders are made, which would follow a link, and again right before the write.
const step = (context: Step, position: number, op: PlanOperation): Stop | undefined => {
  const { store, run, root, at } = context;
  const path = join(root, op.path);
  const linked = linkRefusal(root, op.path);
  if (linked !== undefined) return untouched(linked);
  let mode = context.modes.get(position);
  if (op.beforeHash !== null) {
    const file = orDenied(op.path, () => expected(op.path, op.beforeHash, fileAt(path)));
    if ('code' in file) return untouched(file);
    if (!backUp(file.bytes, store.backupPath(run, position))) {
      return untouched({ code: 'apply.backup-failed', params: { run, path: op.path } });
    }
    mode = file.mode;
    if (op.afterHash === null) store.deleting(run, position, mode);
  }
  const made = makeFolders(dirname(path), 0o777, levels(op.path));
  if (made > 0) store.madeFolders(run, position, made);
  const relinked = linkRefusal(root, op.path);
  if (relinked !== undefined) return untouched(relinked);
  const stopped = written(context, position, op, mode);
  if (stopped === undefined) at('written', position);
  return stopped;
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
      cause: new AggregateError([error, failure], 'a step failed, and the recovery after it failed too', {
        cause: failure,
      }),
    };
  }
};

const journal = (
  { before: _before, after: _after, ...hashes }: PlanOperation,
  entries: SettingsEntry[] | undefined,
): NewRun['operations'][number] => ({ ...hashes, entries: entries ?? null });

// Writes each step in order and ends the run with its last one: null when every step is done, else the step's refusal.
const steps = (context: Step, operations: readonly PlanOperation[]): Refusal | null => {
  const { store, run } = context;
  const last = operations.length - 1;
  for (const [position, op] of operations.entries()) {
    const stopped = step(context, position, op);
    if (stopped !== undefined) {
      store.finish(run, 'failed', [position, stopped.end]);
      return stopped.refusal;
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
  const { root, plan, run, earlier = [], modes = new Map() } = request;
  const findings = [...earlier, ...recover(store, root)];
  const { operations } = plan;
  if (operations.length === 0) return { run: null, refusal: null, findings };
  const problem = unsettledBy(findings) ?? precheck(root, operations) ?? linksProblem(root, operations);
  if (problem !== undefined) return { run: null, refusal: problem, findings };
  const journaled = operations.map((op, position) => journal(op, request.entries?.get(position)));
  const begun = store.begin({ ...run, planHash: plan.planHash, operations: journaled });
  if (!begun.ok) return { run: null, refusal: begun.refusal, findings };
  try {
    return { run: begun.value, refusal: steps({ store, run: begun.value, root, at, modes }, operations), findings };
  } catch (error) {
    // Settled now where the filesystem allows, so the run is not listed as running while this process holds the store.
    const after = afterRecovery(store, root, error);
    throw new StepFailed(begun.value, [...findings, ...after.findings], after.cause);
  }
};
