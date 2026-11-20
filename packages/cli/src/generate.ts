import type { PlanPreview } from '@cedarloom/core';
import { type Generation, generateWorkflows } from '@cedarloom/use-cases';
import type { Io } from './io.ts';
import { withStore } from './locate.ts';
import { message } from './message.ts';
import { columns, type Outcome } from './output.ts';

// The plan's writes and deletes, then the files it keeps.
const planText = ({ operations, skipped }: PlanPreview): string => {
  const steps =
    operations.length === 0 && skipped.length === 0
      ? `${message('output.generate-none')}\n`
      : columns(operations.map(({ kind, path }) => [kind, path]));
  return `${steps}${skipped.map(({ code, params }) => `${message(code, params)}\n`).join('')}`;
};

const textOf = ({ plan, generatorRefusals, run }: Generation, applied: boolean): string => {
  if (plan === null) return columns(generatorRefusals.map(({ file, field, rule }) => [file, field, rule]));
  return `${planText(plan)}${applied ? `${message('output.generate-applied', { run })}\n` : ''}`;
};

/** cedarloom workflows generate [<name>...]: plans the generation of the project's definitions, applied with --yes. */
export const workflowsGenerate = (io: Io, names: readonly string[], yes: boolean, pluginRoot: string | null): Outcome =>
  withStore(io, (store, root) => {
    const generation = generateWorkflows(store, { ...io, pluginRoot, root, names }, yes);
    const { plan, run, refusals, findings, generatorRefusals } = generation;
    const applied = run !== null && refusals.length === 0;
    const unconfirmed = !yes && plan !== null && plan.operations.length > 0;
    return {
      // A refused generation has a result only once its run is recorded.
      result: refusals.length > 0 && run === null ? null : { plan, applied, run, generatorRefusals },
      findings,
      refusals: unconfirmed ? [{ code: 'cli.confirm-required', params: {} }] : refusals,
      failed: generatorRefusals.length > 0,
      text: textOf(generation, applied),
    };
  });
