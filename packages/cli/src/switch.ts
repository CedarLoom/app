import type { Refusal } from '@cedarloom/core';
import { workflowsOff, workflowsOn } from '@cedarloom/use-cases';
import { outcomeOf } from './generate.ts';
import type { Request } from './grammar.ts';
import type { Io } from './io.ts';
import { withStore } from './locate.ts';
import { type Outcome, refused } from './output.ts';

type Command = Extract<Request, { kind: 'command' }>;

// One <id> or --plugin; --script-only and --plugin-root belong to <id>.
const usageRefusal = ({ name, args, plugin, scriptOnly, pluginRoot }: Command): Refusal | undefined => {
  const [id, surplus] = args;
  if (surplus !== undefined) return { code: 'cli.unknown-command', params: { command: surplus, bin: 'cedarloom' } };
  if (!plugin)
    return id === undefined
      ? { code: 'cli.missing-argument', params: { argument: '<id>', command: `cedarloom ${name}` } }
      : undefined;
  const conflict = [
    id === undefined ? null : '<id>',
    scriptOnly ? '--script-only' : null,
    pluginRoot === null ? null : '--plugin-root',
  ].find((flag) => flag !== null);
  return conflict === undefined ? undefined : { code: 'cli.flag-conflict', params: { flags: `${conflict}, --plugin` } };
};

/** cedarloom workflows off and on: plans the switch in .claude/settings.json, applied with --yes. */
export const workflowsSwitch = (io: Io, command: Command): Outcome => {
  const stop = usageRefusal(command);
  if (stop !== undefined) return refused(stop);
  const { name, args, yes, scriptOnly, pluginRoot } = command;
  const id = args[0] ?? null;
  return withStore(io, (store, root) =>
    outcomeOf(
      name === 'workflows off'
        ? workflowsOff(store, { ...io, pluginRoot, root, id, scriptOnly }, yes)
        : workflowsOn(store, { root, id }, yes),
      yes,
    ),
  );
};
