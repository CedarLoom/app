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

// Restores a path that hashes as the step left it. One that hashes as before this step or an earlier one on it needs
// nothing, and so does one still as before the run that no planned operation changes.
const visit = (walk: Walk, position: number, step: Operation): Refusal | undefined => {
  const link = linkRefusal(walk.root, step.path);
  if (link !== undefined) return link;
  const key = fileKey(step.path);
  const planned = walk.now.has(key);
  const current = planned ? walk.now.get(key) : textAt(walk.root, step.path);
  if (current === undefined) return refusal('undo.file-changed', step.path);
  const hash = hashOf(current);
  const states = walk.started
    .filter(([at, op]) => at <= position && fileKey(op.path) === key)
    .map(([, op]) => op.beforeHash);
  if (!planned && hash === states[0]) return undefined;
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

// Each run down an undo's chain still names that undo as its newest done one, or names none in effect where the undo did
// not finish; otherwise a newer undo replaced it, and undoing it would leave the chain's state at odds with its files.
const replaced = (store: RunStore, run: Run): Refusal | undefined => {
  const target = run.undoes === null ? undefined : store.run(run.undoes);
  if (target === undefined) return undefined;
  const by = target.undoneBy === null ? undefined : store.run(target.undoneBy);
  const current = run.status === 'done' ? target.undoneBy === run.id : by === undefined || !inEffect(store, by);
  if (!current) return { code: 'run.already-undone', params: { run: target.id, by: target.undoneBy } };
  return replaced(store, target);
};

// Recovery leaves a run running while a link is on the way of its step; undo waits until that step is settled.
const unsettled = (root: string, run: Run): Refusal | undefined => {
  const step = run.status === 'running' ? run.operations.find((op) => op.status === 'pending') : undefined;
  return step === undefined ? undefined : linkRefusal(root, step.path);
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
  // A failed step with a backup may have dropped the old file before it stopped.
  const started = [...run.operations.entries()].filter(
    ([position, op]) =>
      op.status === 'done' ||
      op.status === 'settled' ||
      (op.status === 'failed' && entryAt(store.backupPath(run.id, position)) !== undefined),
  );
  const walk: Walk = { root, store, run: run.id, started, now: new Map(), operations: [] };
  for (const [position, step] of started.toReversed()) {
    const stop = visit(walk, position, step);
    if (stop !== undefined) return refused(stop);
  }
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
