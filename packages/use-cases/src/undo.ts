import { isUtf8 } from 'node:buffer';
import { join } from 'node:path';
import { type Finding, PlanOperation, type PlanPreview, planHash, type Refusal, type Run } from '@cedarloom/core';
import { type Applied, type ApplyRequest, type At, apply, fileKey, linkRefusal, refusal } from './apply.ts';
import { entryAt, readFound, sha256 } from './project-files.ts';
import { type Operation, recover } from './recover.ts';
import type { NewRun, RunStore } from './store.ts';

export interface UndoRequest {
  /** The project root, absolute; the run's paths are relative to it. */
  root: string;
  /** The id of the run to undo, as the caller gave it. */
  run: string;
}

// The undo plan, or the refusal that stops it; findings: apply.recovered for what recovery settled first.
type UndoPlan =
  | { plan: PlanPreview; refusal: null; findings: Finding[] }
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
  walk.operations.push(operation(step.path, current, before));
  walk.now.set(key, before);
  return undefined;
};

// A run is in effect while no done undo run undid it, or the newest one is itself no longer in effect.
const inEffect = (store: RunStore, run: Run): boolean => {
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

// Recovery leaves a run running while a link is on the way of its step; undo waits until that step is settled.
const unsettled = (root: string, run: Run): Refusal | undefined => {
  const step = run.status === 'running' ? run.operations.find((op) => op.status === 'pending') : undefined;
  return step === undefined ? undefined : linkRefusal(root, step.path);
};

// A failed step with a backup may have dropped the old file before it stopped.
const startedOf = (store: RunStore, run: Run): [number, Operation][] =>
  [...run.operations.entries()].filter(
    ([position, op]) =>
      op.status === 'done' ||
      op.status === 'settled' ||
      (op.status === 'failed' && entryAt(store.backupPath(run.id, position)) !== undefined),
  );

// Each file the run started a step on is as before its first step on it, once the walk's own writes are done.
const asBefore = (walk: Walk, run: Run): Refusal | undefined => {
  const seen = new Set<string>();
  for (const [, step] of startedOf(walk.store, run)) {
    const key = fileKey(step.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const current = walk.now.has(key) ? walk.now.get(key) : textAt(walk.root, step.path);
    if (current === undefined || hashOf(current) !== step.beforeHash) return refusal('undo.file-changed', step.path);
  }
  return undefined;
};

// Undoing a run brings back the undo it undid, and so every second run down the chain; each one that is done says the run
// it undid has its files as before it. An undo that restored nothing wrote nothing to show that, so the files are read.
const claimed = (walk: Walk, run: Run): Refusal | undefined => {
  const back = run.undoes === null ? undefined : walk.store.run(run.undoes);
  const undid = back?.status === 'done' && back.undoes !== null ? walk.store.run(back.undoes) : undefined;
  if (undid === undefined) return undefined;
  return asBefore(walk, undid) ?? claimed(walk, undid);
};

// Steps are visited newest first, so each path ends as before the run's first step on it.
const walked = (walk: Walk, run: Run): Refusal | undefined => {
  for (const [position, step] of walk.started.toReversed()) {
    const stop = visit(walk, position, step);
    if (stop !== undefined) return stop;
  }
  return claimed(walk, run);
};

// Recovery runs first, so an interrupted run is undone from its settled journal.
const planUndo = (store: RunStore, { root, run: id }: UndoRequest): UndoPlan => {
  const findings = recover(store, root);
  const refused = (stop: Refusal): UndoPlan => ({ plan: null, refusal: stop, findings });
  const run = store.run(id);
  if (run === undefined) return refused({ code: 'run.not-found', params: { run: id } });
  if (!inEffect(store, run)) return refused({ code: 'run.already-undone', params: { run: run.id, by: run.undoneBy } });
  const blocked = replaced(store, run) ?? unsettled(root, run);
  if (blocked !== undefined) return refused(blocked);
  const walk: Walk = { root, store, run: run.id, started: startedOf(store, run), now: new Map(), operations: [] };
  const stop = walked(walk, run);
  if (stop !== undefined) return refused(stop);
  const { operations } = walk;
  return { plan: { planHash: planHash(operations, sha256), operations, skipped: [] }, refusal: null, findings };
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
  const { plan, findings } = planned;
  if (plan.operations.length === 0) {
    return { ...recordDone(store, { ...run, planHash: plan.planHash }), findings, plan };
  }
  const applied = apply(store, { root: request.root, plan, run }, at);
  return { ...applied, findings: [...findings, ...applied.findings], plan };
};
