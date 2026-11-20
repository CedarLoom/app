import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Finding, GeneratorRefusal } from '@cedarloom/core';
import { z } from 'zod';
import { filesBelow } from './files-below.ts';
import { errorCode } from './project-files.ts';

export interface GeneratorRun {
  /** The root of the located, trusted cl-workflow plugin, or the --plugin-root folder. */
  root: string;
  /** The folder the run's temporary folder is made in, outside the project. */
  temp: string;
  timeoutMs: number;
  env: Readonly<Record<string, string | undefined>>;
}

/** The generator's files by "/"-separated path below its output folder; or its refusals per definition; or why neither. */
export type Generated = { outputs: Map<string, Buffer> } | { refusals: GeneratorRefusal[][] } | { finding: Finding };

/** A generator run takes well under a second; this ends one that hangs. */
export const GENERATOR_TIMEOUT_MS = 30_000;
// What the generator prints with --json: one { file, field, rule } per refusal.
const Refusals = z.array(z.object({ file: z.string(), field: z.string(), rule: z.string() }));
const LIMIT = 4096;
const OUTPUT_LIMIT = 64 * 1024 * 1024;

// Windows needs SystemRoot to start a process; nothing else of the caller's environment reaches the generator.
const childEnv = (env: GeneratorRun['env']): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[0].toUpperCase() === 'SYSTEMROOT' && entry[1] !== undefined,
    ),
  );

export const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const failed = ({ status, signal, stderr }: SpawnSyncReturns<string>): Generated => ({
  finding: {
    code: 'generator.failed',
    severity: 'error',
    params: { exitCode: status, signal, stderr: stderr.slice(0, LIMIT) },
  },
});
/** Output of the generator CedarLoom cannot read. */
export const unknownOutput = (output: string): { finding: Finding } => ({
  finding: { code: 'generator.output-unknown', severity: 'error', params: { output: output.slice(0, LIMIT) } },
});

// The refusals of each file, in their order, from the list a run that exited with 0 or 1 printed; or why it gave none.
const refusalsOf = (run: SpawnSyncReturns<string>, files: string[]): GeneratorRefusal[][] | Generated => {
  const { status, stdout } = run;
  const refusals = Refusals.safeParse(jsonOf(stdout));
  // Node.js exits with 1 on an uncaught error too, which leaves its stack trace on stderr; the generator prints its
  // refusal list before it writes, so an error in a write leaves an empty one.
  if (status === 1 && !(refusals.success && refusals.data.length > 0)) return failed(run);
  if (!refusals.success || (status === 0) !== (refusals.data.length === 0)) return unknownOutput(stdout);
  const own = files.map((file) => refusals.data.filter((refusal) => refusal.file === file));
  return own.reduce((sum, list) => sum + list.length, 0) === refusals.data.length ? own : unknownOutput(stdout);
};

const outcome = (run: SpawnSyncReturns<string>, files: string[], out: string): Generated => {
  if (run.signal !== null || (run.status !== 0 && run.status !== 1)) return failed(run);
  const refusals = refusalsOf(run, files);
  if (!Array.isArray(refusals)) return refusals;
  if (run.status === 1) return { refusals };
  // A generator that wrote nothing leaves no output folder.
  if (!existsSync(out)) return { outputs: new Map() };
  return { outputs: new Map(filesBelow(out).map((path) => [path, readFileSync(join(out, path))])) };
};

/**
 * Runs the plugin's generator on the definitions' bytes in one run, as a project regenerates them, in a temporary
 * folder of its own that is removed afterwards.
 */
export const generate = (definitions: Uint8Array[], request: GeneratorRun): Generated => {
  // Absolute, as the generator resolves the paths it gets from its own working folder.
  const folder = mkdtempSync(join(resolve(request.temp), 'cedarloom-generate-'));
  try {
    // Copies, so the generator reads neither a link nor a FIFO from the project, and writes only into this folder.
    mkdirSync(join(folder, 'definitions'));
    const files = definitions.map((bytes, index) => {
      const file = join(folder, 'definitions', `${index}.json`);
      writeFileSync(file, bytes);
      return file;
    });
    const out = join(folder, 'out');
    const generator = join(request.root, 'generator', 'generate.mjs');
    const run = spawnSync(process.execPath, [generator, ...files, '--json', '--prefix', '', '--out', out], {
      cwd: folder,
      env: childEnv(request.env),
      encoding: 'utf8',
      // The refusal list of a large definition can pass the default of 1 MiB.
      maxBuffer: OUTPUT_LIMIT,
      timeout: request.timeoutMs,
      // A generator that ignores SIGTERM would keep the doctor waiting.
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    // ETIMEDOUT and ENOBUFS end the generator, which the outcome reports by its signal.
    const code = errorCode(run.error);
    if (run.error !== undefined && code !== 'ETIMEDOUT' && code !== 'ENOBUFS') throw run.error;
    return outcome(run, files, out);
  } finally {
    // A virus scanner or indexer on Windows can hold a file just written for a moment.
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  }
};
