import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { doctorRun } from './doctor.ts';
import { type Parsed, parse, type Request } from './grammar.ts';
import type { Io } from './io.ts';
import { message } from './message.ts';
import { exitCode, type Outcome, refused, write } from './output.ts';
import { runsList, runsShow } from './runs.ts';
import { undoRun } from './undo.ts';

export type { Io } from './io.ts';

const HELP = {
  doctor: 'help.doctor',
  'runs list': 'help.runs-list',
  'runs show': 'help.runs-show',
  undo: 'help.undo',
  runs: 'help.runs',
} as const;

const commandOutcome = (io: Io, request: Extract<Request, { kind: 'command' }>): Outcome => {
  const { name, yes, pluginRoot } = request;
  const argument = request.argument ?? '';
  if (name === 'doctor') return doctorRun(io, pluginRoot);
  if (name === 'runs list') return runsList(io);
  if (name === 'runs show') return runsShow(io, argument);
  return undoRun(io, argument, yes);
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
    io.stderr(`${error instanceof Error ? error.stack : String(error)}\n`);
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
    cwd: process.cwd(),
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
