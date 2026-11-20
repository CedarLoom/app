import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { printableStack, type Refusal } from '@cedarloom/core';
import { doctorRun } from './doctor.ts';
import { type EditVerb, workflowsEdit } from './edit-workflow.ts';
import { workflowsGenerate } from './generate.ts';
import { workflowsNew } from './new-workflow.ts';
import { type Parsed, parse, type Request } from './grammar.ts';
import type { Io } from './io.ts';
import { message } from './message.ts';
import { exitCode, type Outcome, refused, write } from './output.ts';
import { runsList, runsShow } from './runs.ts';
import { workflowsSwitch } from './switch.ts';
import { undoRun } from './undo.ts';
import { workflowsList, workflowsShow, workflowsValidate } from './workflows.ts';

export type { Io } from './io.ts';

const HELP = {
  doctor: 'help.doctor',
  'runs list': 'help.runs-list',
  'runs show': 'help.runs-show',
  undo: 'help.undo',
  'workflows list': 'help.workflows-list',
  'workflows show': 'help.workflows-show',
  'workflows validate': 'help.workflows-validate',
  'workflows generate': 'help.workflows-generate',
  'workflows new': 'help.workflows-new',
  'workflows add': 'help.workflows-add',
  'workflows move': 'help.workflows-move',
  'workflows remove': 'help.workflows-remove',
  'workflows set': 'help.workflows-set',
  'workflows off': 'help.workflows-off',
  'workflows on': 'help.workflows-on',
  runs: 'help.runs',
  workflows: 'help.workflows',
} as const;

type Command = Extract<Request, { kind: 'command' }>;

const edit = (io: Io, verb: EditVerb, { args, unset, yes, pluginRoot }: Command): Outcome =>
  workflowsEdit(io, { verb, args, unset, pluginRoot }, yes);

const OUTCOMES: Record<Command['name'], (io: Io, command: Command, argument: string) => Outcome> = {
  doctor: (io, { pluginRoot }) => doctorRun(io, pluginRoot),
  'runs list': (io) => runsList(io),
  'runs show': (io, _, argument) => runsShow(io, argument),
  undo: (io, { yes }, argument) => undoRun(io, argument, yes),
  'workflows list': (io, { pluginRoot }) => workflowsList(io, pluginRoot),
  'workflows show': (io, { shipped, pluginRoot }, argument) => workflowsShow(io, argument, shipped, pluginRoot),
  'workflows validate': (io, { args, shipped, pluginRoot }) => workflowsValidate(io, args, shipped, pluginRoot),
  'workflows generate': (io, { args, yes, pluginRoot }) => workflowsGenerate(io, args, yes, pluginRoot),
  'workflows new': (io, { from, yes, pluginRoot }, name) =>
    workflowsNew(io, { name, from: from ?? 'dev', pluginRoot }, yes),
  'workflows add': (io, command) => edit(io, 'add', command),
  'workflows move': (io, command) => edit(io, 'move', command),
  'workflows remove': (io, command) => edit(io, 'remove', command),
  'workflows set': (io, command) => edit(io, 'set', command),
  'workflows off': workflowsSwitch,
  'workflows on': workflowsSwitch,
};

// Every command reads the working folder, which the process cannot read once it was removed. The shell's PWD may name
// another folder when a program started the process, so the refusal names the folder ".".
const workingFolder = (io: Io): string | Refusal => {
  try {
    return io.cwd;
  } catch {
    return { code: 'project.not-found', params: { cwd: '.' } };
  }
};

const commandOutcome = (io: Io, command: Command): Outcome => {
  const cwd = workingFolder(io);
  if (typeof cwd !== 'string') return refused(cwd);
  const [argument = ''] = command.args;
  return OUTCOMES[command.name]({ ...io, cwd }, command, argument);
};

const textOf = (request: Exclude<Request, { kind: 'command' }>, io: Io): string => {
  if (request.kind === 'version') return `${io.version}\n`;
  return `${message(request.topic === null ? 'help.cedarloom' : HELP[request.topic])}\n`;
};

const outcomeOf = (parsed: Parsed, io: Io): Outcome => {
  if (!parsed.ok) return refused(parsed.refusal);
  if (parsed.value.kind !== 'command')
    return { result: null, findings: [], refusals: [], text: textOf(parsed.value, io) };
  return commandOutcome(io, parsed.value);
};

/** Runs one command line and returns its exit code. */
export const main = (io: Io): number => {
  const parsed = parse(io.argv);
  const json = parsed.ok ? parsed.value.kind === 'command' && parsed.value.json : parsed.json;
  try {
    const outcome = outcomeOf(parsed, io);
    write(outcome, json, io);
    return exitCode(outcome);
  } catch (error) {
    io.stderr(`${printableStack(error)}\n`);
    const crashed = refused({ code: 'cli.internal', params: {} });
    write(crashed, json, io);
    return exitCode(crashed);
  }
};

/** The bins' entry: runs the process's command line and sets its exit code; the manifest is the package's own. */
export const run = (manifest: { version: string; engines: { node: string } }): void => {
  process.exitCode = main({
    argv: process.argv.slice(2),
    env: process.env,
    // Read only by a command that needs it, so --version and --help answer in a removed working folder too.
    get cwd() {
      return process.cwd();
    },
    home: homedir(),
    platform: process.platform,
    realpath: realpathSync.native,
    node: process.versions.node,
    version: manifest.version,
    required: manifest.engines.node,
    clock: { now: () => new Date(), newRunId: randomUUID },
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
};
