import { isUtf8 } from 'node:buffer';
import { dirname, join } from 'node:path';
import {
  type Finding,
  type Hash,
  PlanOperation,
  type PlanPreview,
  planHash,
  type Refusal,
  type Run,
} from '@cedarloom/core';
import { type Applied, type ApplyRequest, type At, apply, fileKey, linkRefusal, refusal } from './apply.ts';
import { entryAt, errorCode, readFound, removeEmptyFolder, sha256 } from './project-files.ts';
import { type Operation, recover, unsettledBy } from './recover.ts';
import type { NewRun, RunStore } from './store.ts';
import { linkOnWay } from './write-roots.ts';

export interface UndoRequest {
  /** The project root, absolute; the run's paths are relative to it. */
  root: string;
  /** The id of the run to undo, as the caller gave it. */
  run: string;
  /** The hash of the undo plan the caller showed; undo refuses with plan.stale when the plan it makes now differs. */
  planHash?: Hash;
}

/**
 * The undo plan, or the refusal that stops it; findings: what recovery settled first, or could not; modes: the
 * permission bits each create gives back, by its position in the plan.
 */
export type UndoPlan =
  | { plan: PlanPreview; refusal: null; findings: Finding[]; modes: ReadonlyMap<number, number> }
  | { plan: null; refusal: Refusal; findings: Finding[] };

export type Undone = Applied & { plan: PlanPreview | null };

const hashOf = (text: string | null): string | null => (text === null ? null : sha256(Buffer.from(text)));

// A text file's text, null for nothing; undefined for anything no step leaves, such as a link or a binary file.
const textAt = (root: string, path: string): string | null | undefined => {
  const found = readFound(join(root, path));
  if (found === 'absent') return null;
  return typeof found === 'object' && isUtf8(found.bytes) ? found.bytes.toString('utf8') : undefined;
};

const kindOf = (before: string | null, after: string | null): PlanOperation['kind'] => {
  if (before === null) return 'create';
  return after === null ? 'delete' : 'replace';
};

// The operation that takes a path from one text to another, null being no file.
const operation = (path: string, before: string | null, after: string | null): PlanOperation =>
  PlanOperation.parse({
    kind: kindOf(before, after),
    path,
    beforeHash: hashOf(before),
    afterHash: hashOf(after),
    before,
    after,
  });

interface Walk {
  root: string;
  store: RunStore;
  run: string;
  /** The run's started steps by position, oldest first. */
  started: [number, Operation][];
  /** Each file's text once the undo operations planned so far ran, by fileKey. */
  now: Map<string, string | null>;
  operations: PlanOperation[];
  modes: Map<number, number>;
}

// The text the step found, from the backup it made; a create found nothing.
const textBefore = ({ store, run }: Walk, position: number, step: Operation): string | null | Refusal => {
  if (step.beforeHash === null) return null;
  const found = readFound(store.backupPath(run, position));
  if (found === 'absent') return refusal('undo.backup-missing', step.path);
  if (typeof found !== 'object' || sha256(found.bytes) !== step.beforeHash) {
    return refusal('undo.backup-changed', step.path);
  }
  return found.bytes.toString('utf8');
};

// A path as before the run's first step on it needs nothing; one that hashes as the step left it is restored, and one
// that hashes as before another step of the run on it needs nothing either.
const visit = (walk: Walk, position: number, step: Operation): Refusal | undefined => {
  const link = linkRefusal(walk.root, step.path);
  if (link !== undefined) return link;
  const key = fileKey(step.path);
  const current = walk.now.has(key) ? walk.now.get(key) : textAt(walk.root, step.path);
  if (current === undefined) return refusal('undo.file-changed', step.path);
  const hash = hashOf(current);
  const states = walk.started.filter(([, op]) => fileKey(op.path) === key).map(([, op]) => op.beforeHash);
  if (hash === states[0]) return undefined;
  if (hash !== step.afterHash) return states.includes(hash) ? undefined : refusal('undo.file-changed', step.path);
  const before = textBefore(walk, position, step);
  if (typeof before === 'object' && before !== null) return before;
  if (step.mode !== null) walk.modes.set(walk.operations.length, step.mode);
  walk.operations.push(operation(step.path, current, before));
  walk.now.set(key, before);
  return undefined;
};

// A run is in effect while no done undo run undid it, or the newest one is itself no longer in effect.
export const inEffect = (store: RunStore, run: Run): boolean => {
  const by = run.undoneBy === null ? undefined : store.run(run.undoneBy);
  return by === undefined || !inEffect(store, by);
};

// Names the undo that decides a run's state, and whether that undo is still in effect.
const stale = (store: RunStore, run: Run): Refusal => {
  const by = run.undoneBy === null ? undefined : store.run(run.undoneBy);
  const code = by !== undefined && inEffect(store, by) ? 'run.already-undone' : 'undo.replaced';
  return { code, params: { run: run.id, by: run.undoneBy } };
};

// Each run down an undo's chain is in effect as the undos above it say: a done undo takes its run out of effect, one that
// did not finish leaves it in effect. While every undo above is done, each is also the newest done undo of its run;
// otherwise a newer undo replaced it, and undoing it would leave the chain's state at odds with its files.
const replaced = (store: RunStore, run: Run, wanted = true, belowUnfinished = false): Refusal | undefined => {
  const target = run.undoes === null ? undefined : store.run(run.undoes);
  if (target === undefined) return undefined;
  const done = run.status === 'done';
  const want = done ? !wanted : true;
  const current = done && !belowUnfinished ? target.undoneBy === run.id : inEffect(store, target) === want;
  if (!current) return stale(store, target);
  return replaced(store, target, want, belowUnfinished || !done);
};

// A pending step never started, and an untouched one stopped before any change.
const startedOf = (run: Run): [number, Operation][] =>
  [...run.operations.entries()].filter(([, op]) => op.status !== 'pending' && op.status !== 'untouched');

// A file the run's undo `back` did not write still holds a result of the run: it hashes as a started step left it, and
// not as before the run's first step on it. Any other content is not the run's, and no undo of the chain writes it.
// A file `back` wrote holds the run's result only through an undo of `back`: the one this walk restores, or one that
// did not finish and still counts. So does an unfinished undo of the run that `run` itself undid, for the file it wrote.
const kept = (walk: Walk, run: Run, back: Run): Refusal | undefined => {
  const { store } = walk;
  const restored = new Set(startedOf(back).map(([, step]) => fileKey(step.path)));
  const held = (run.undoes === null ? [] : store.unfinishedUndos(run.undoes))
    .filter((undo) => undo.id !== run.id && inEffect(store, undo))
    .flatMap((undo) => startedOf(undo).map(([, step]) => step));
  const started = startedOf(run).map(([, step]) => step);
  const left = started.find((step) => {
    const key = fileKey(step.path);
    if (restored.has(key)) return false;
    const current = textAt(walk.root, step.path);
    const hash = current === undefined ? undefined : hashOf(current);
    if (hash !== step.afterHash || hash === started.find((op) => fileKey(op.path) === key)?.beforeHash) return false;
    return !held.some((op) => fileKey(op.path) === key && op.afterHash === hash);
  });
  return left && { code: 'undo.result-kept', params: { path: left.path, run: run.id } };
};

// Undoing a run brings back the undo it undid, and so every second run down the chain; each one that is done says the run
// it undid left no result. Where it restored nothing it wrote nothing to show that, so those files are read.
const claimed = (walk: Walk, run: Run): Refusal | undefined => {
  const back = run.undoes === null ? undefined : walk.store.run(run.undoes);
  const undid = back?.status === 'done' && back.undoes !== null ? walk.store.run(back.undoes) : undefined;
  if (back === undefined || undid === undefined) return undefined;
  return kept(walk, undid, back) ?? claimed(walk, undid);
};

// Steps are visited newest first, so each path ends as before the run's first step on it.
const walked = (walk: Walk, run: Run): Refusal | undefined => {
  for (const [position, step] of walk.started.toReversed()) {
    const stop = visit(walk, position, step);
    if (stop !== undefined) return stop;
  }
  return claimed(walk, run);
};

/** Plans the undo of a run without applying it. Recovery runs first, so an interrupted run is undone from its settled journal. */
export const planUndo = (store: RunStore, { root, run: id }: UndoRequest): UndoPlan => {
  const findings = recover(store, root);
  const refused = (stop: Refusal): UndoPlan => ({ plan: null, refusal: stop, findings });
  const run = store.run(id);
  if (run === undefined) return refused({ code: 'run.not-found', params: { run: id } });
  if (!inEffect(store, run)) return refused({ code: 'run.already-undone', params: { run: run.id, by: run.undoneBy } });
  const blocked = replaced(store, run) ?? unsettledBy(findings);
  if (blocked !== undefined) return refused(blocked);
  const started = startedOf(run);
  const walk: Walk = { root, store, run: run.id, started, now: new Map(), operations: [], modes: new Map() };
  const stop = walked(walk, run);
  if (stop !== undefined) return refused(stop);
  const { operations, modes } = walk;
  return { plan: { planHash: planHash(operations, sha256), operations, skipped: [] }, refusal: null, findings, modes };
};

// Deepest first, while each is a plain folder that holds nothing; a folder that stays keeps the ones above it.
const removeMadeFolders = (root: string, run: Run): void => {
  for (const { path, madeFolders } of run.operations.toReversed()) {
    let folder = dirname(path);
    for (let left = madeFolders; left > 0; left -= 1, folder = dirname(folder)) {
      const absolute = join(root, folder);
      const plain = linkOnWay(root, folder) === undefined && entryAt(absolute)?.isDirectory() === true;
      if (!plain || !removeEmptyFolder(absolute)) break;
    }
  }
};

// The undo is done once its files are; a folder the filesystem keeps from it stays.
const tidy = (root: string, run: Run): void => {
  try {
    removeMadeFolders(root, run);
  } catch (error) {
    if (errorCode(error) === undefined) throw error;
  }
};

// Every file is already as before the run: the undo is recorded all the same, so the run is no longer in effect.
const recordDone = (store: RunStore, run: Omit<NewRun, 'operations'>): Omit<Applied, 'findings'> => {
  const begun = store.begin({ ...run, operations: [] });
  if (!begun.ok) return { run: null, refusal: begun.refusal };
  store.finish(begun.value, 'done');
  return { run: begun.value, refusal: null };
};

/** Undoes a run as a run of its own: plans the undo, then applies it as any plan, crash-ordered. */
export const undo = (store: RunStore, request: UndoRequest, at?: At): Undone => {
  const planned = planUndo(store, request);
  if (planned.plan === null) return { run: null, refusal: planned.refusal, findings: planned.findings, plan: null };
  const run: ApplyRequest['run'] = {
    kind: 'undo',
    action: 'undo',
    subject: request.run,
    undoes: request.run,
    generatedFrom: [],
  };
  const { plan, findings, modes } = planned;
  if (request.planHash !== undefined && request.planHash !== plan.planHash) {
    return { run: null, refusal: { code: 'plan.stale', params: {} }, findings, plan: null };
  }
  const done =
    plan.operations.length === 0
      ? { ...recordDone(store, { ...run, planHash: plan.planHash }), findings }
      : apply(store, { root: request.root, plan, run, earlier: findings, modes }, at);
  const undid = store.run(request.run);
  if (done.refusal === null && undid !== undefined) tidy(request.root, undid);
  return { ...done, plan };
};
