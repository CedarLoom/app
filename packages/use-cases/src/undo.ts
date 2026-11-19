import { isUtf8 } from 'node:buffer';
import { join } from 'node:path';
import {
  type Finding,
  PlanOperation,
  type PlanPreview,
  planHash,
  type Refusal,
  type Run,
  RunId,
} from '@cedarloom/core';
import { type Applied, type ApplyRequest, type At, apply } from './apply.ts';
import { readFound, sha256 } from './project-files.ts';
import { recover } from './recover.ts';
import type { RunStore } from './store.ts';
import { linkOnWay } from './write-roots.ts';

export interface UndoRequest {
  /** The project root, absolute; the run's paths are relative to it. */
  root: string;
  /** The id of the run to undo, as the caller gave it. */
  run: string;
}

/** The undo plan, or the refusal that stops it; findings: apply.recovered for what recovery settled first. */
export type UndoPlan =
  | { plan: PlanPreview; refusal: null; findings: Finding[] }
  | { plan: null; refusal: Refusal; findings: Finding[] };

export type Undone = Applied & { plan: PlanPreview | null };

type Operation = Run['operations'][number];

const refusal = (code: Refusal['code'], path: string): Refusal => ({ code, params: { path } });

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
  /** Each path's hash before the run's first started step on it. */
  original: Map<string, string | null>;
  /** Each path's text once the undo operations planned so far ran. */
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

// Restores a path that hashes as the step left it; one that hashes as before the step, or before the run, needs nothing.
const visit = (walk: Walk, position: number, step: Operation): Refusal | undefined => {
  const current = walk.now.has(step.path) ? walk.now.get(step.path) : textAt(walk.root, step.path);
  if (current === undefined) return refusal('undo.file-changed', step.path);
  const hash = hashOf(current);
  if (hash !== step.afterHash) {
    return hash === step.beforeHash || hash === walk.original.get(step.path)
      ? undefined
      : refusal('undo.file-changed', step.path);
  }
  const before = textBefore(walk, position, step);
  if (typeof before === 'object' && before !== null) return before;
  walk.operations.push(operation(step.path, current, before));
  walk.now.set(step.path, before);
  return undefined;
};

// A run is in effect while no done undo run undid it, or the newest one is itself no longer in effect.
const inEffect = (store: RunStore, run: Run): boolean => {
  const by = run.undoneBy === null ? undefined : store.run(run.undoneBy);
  return by === undefined || !inEffect(store, by);
};

// Recovery leaves a run running while a link is on the way of its step; undo waits until that step is settled.
const unsettled = (root: string, run: Run): Refusal | undefined => {
  const step = run.status === 'running' ? run.operations.find((op) => op.status === 'pending') : undefined;
  const link = step === undefined ? undefined : linkOnWay(root, step.path);
  return link === undefined ? undefined : refusal('plan.symlink', link);
};

/**
 * Plans the undo of a run on the held store, after recovery settled what interrupted runs left: each path the run's
 * started steps changed goes back to its text from before the run, newest step first, where it still hashes as the
 * run left it. A failed or pending step changed nothing to restore.
 */
export const planUndo = (store: RunStore, { root, run: id }: UndoRequest): UndoPlan => {
  const findings = recover(store, root);
  const refused = (stop: Refusal): UndoPlan => ({ plan: null, refusal: stop, findings });
  const run = RunId.safeParse(id).success ? store.run(id) : undefined;
  if (run === undefined) return refused({ code: 'run.not-found', params: { run: id } });
  if (!inEffect(store, run)) return refused({ code: 'run.already-undone', params: { run: run.id, by: run.undoneBy } });
  const waiting = unsettled(root, run);
  if (waiting !== undefined) return refused(waiting);
  const started = [...run.operations.entries()].filter(([, op]) => op.status === 'done' || op.status === 'settled');
  const walk: Walk = { root, store, run: run.id, original: new Map(), now: new Map(), operations: [] };
  for (const [, step] of started) if (!walk.original.has(step.path)) walk.original.set(step.path, step.beforeHash);
  for (const [position, step] of started.toReversed()) {
    const stop = visit(walk, position, step);
    if (stop !== undefined) return refused(stop);
  }
  const { operations } = walk;
  return { plan: { planHash: planHash(operations, sha256), operations, skipped: [] }, refusal: null, findings };
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
  const applied = apply(store, { root: request.root, plan: planned.plan, run }, at);
  return { ...applied, findings: [...planned.findings, ...applied.findings], plan: planned.plan };
};
