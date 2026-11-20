import { newWorkflow } from '@cedarloom/use-cases';
import { outcomeOf } from './generate.ts';
import type { Io } from './io.ts';
import { withStore } from './locate.ts';
import type { Outcome } from './output.ts';

/** cedarloom workflows new <name>: plans a copy of a shipped definition under the name with its files, applied with --yes. */
export const workflowsNew = (
  io: Io,
  { name, from, pluginRoot }: { name: string; from: string; pluginRoot: string | null },
  yes: boolean,
): Outcome =>
  withStore(io, (store, root) => outcomeOf(newWorkflow(store, { ...io, pluginRoot, root, name, from }, yes), yes));
