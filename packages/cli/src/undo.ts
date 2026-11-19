import { type PlanPreview, RunId } from '@cedarloom/core';
import { openStore, planUndo, undo } from '@cedarloom/use-cases';
import type { Io } from './io.ts';
import { locate } from './locate.ts';
import { message } from './message.ts';
import { columns, type Outcome, refused } from './output.ts';

const planText = (plan: PlanPreview, run: string): string =>
  plan.operations.length === 0
    ? `${message('output.undo-no-steps', { run })}\n`
    : columns(plan.operations.map(({ kind, path }) => [kind, path]));

const result = (plan: PlanPreview | null, applied: boolean, run: string | null) => ({
  plan,
  applied,
  run,
  generatorRefusals: [],
});

// Without --yes: the plan, not applied.
const shown = (store: Parameters<typeof planUndo>[0], root: string, run: string): Outcome => {
  const planned = planUndo(store, { root, run });
  if (planned.plan === null) return refused(planned.refusal, planned.findings);
  return {
    result: result(planned.plan, false, null),
    findings: planned.findings,
    refusals: [{ code: 'cli.confirm-required', params: {} }],
    text: planText(planned.plan, run),
  };
};

const applied = (store: Parameters<typeof undo>[0], root: string, target: string): Outcome => {
  const { plan, run, refusal, findings } = undo(store, { root, run: target });
  const done = refusal === null && run !== null;
  const summary = done ? `${message('output.undo-applied', { run })}\n` : '';
  return {
    // A refused undo has a result only once its run is recorded.
    result: refusal !== null && run === null ? null : result(plan, done, run),
    findings,
    refusals: refusal === null ? [] : [refusal],
    text: plan === null ? '' : `${planText(plan, target)}${summary}`,
  };
};

/** cedarloom undo <run>: plans the undo of a run, and applies it with --yes. */
export const undoRun = (io: Io, run: string, yes: boolean): Outcome => {
  if (!RunId.safeParse(run).success) return refused({ code: 'run.not-found', params: { run } });
  const place = locate(io);
  if ('refusal' in place) return refused(place.refusal);
  const store = openStore(place.dir, io.clock);
  if (!store.ok) return refused(store.refusal);
  try {
    return yes ? applied(store.value, place.root, run) : shown(store.value, place.root, run);
  } finally {
    store.value.close();
  }
};
