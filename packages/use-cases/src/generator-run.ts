import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Finding } from '@cedarloom/core';
import { z } from 'zod';
import { errorCode } from './project-files.ts';

export interface GeneratorRun {
  /** The root of the located, trusted cl-workflow plugin, or the --plugin-root folder. */
  root: string;
  /** The folder the run's temporary folder is made in, outside the project. */
  temp: string;
  timeoutMs: number;
  env: Readonly<Record<string, string | undefined>>;
}

/** The generator's files by their path below the output folder, with "/" as separator, or its refusal count, or why it gave neither. */
export type Generated = { outputs: Map<string, Buffer> } | { refusals: number } | { finding: Finding };

// What the generator prints with --json: one { file, field, rule } per refusal.
const Refusals = z.array(z.object({ file: z.string(), field: z.string(), rule: z.string() }));
const LIMIT = 4096;

// Windows needs SystemRoot to start a process; nothing else of the caller's environment reaches the generator.
const childEnv = (env: GeneratorRun['env']): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[0].toUpperCase() === 'SYSTEMROOT' && entry[1] !== undefined,
    ),
  );

const filesBelow = (folder: string): Map<string, Buffer> =>
  new Map(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [relative(folder, path).split(sep).join('/'), readFileSync(path)];
      }),
  );

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const outcome = (run: SpawnSyncReturns<string>, out: string): Generated => {
  const { status, signal, stdout, stderr } = run;
  if (signal !== null || (status !== 0 && status !== 1)) {
    const params = { exitCode: status, signal, stderr: stderr.slice(0, LIMIT) };
    return { finding: { code: 'generator.failed', severity: 'error', params } };
  }
  const refusals = Refusals.safeParse(jsonOf(stdout));
  if (!refusals.success || (status === 0) !== (refusals.data.length === 0)) {
    const params = { output: stdout.slice(0, LIMIT) };
    return { finding: { code: 'generator.output-unknown', severity: 'error', params } };
  }
  if (status === 1) return { refusals: refusals.data.length };
  // A generator that wrote nothing leaves no output folder.
  return { outputs: existsSync(out) ? filesBelow(out) : new Map() };
};

/** Runs the plugin's generator on a definition's bytes in a temporary folder of its own, which is removed afterwards. */
export const generate = (definition: Uint8Array, request: GeneratorRun): Generated => {
  const folder = mkdtempSync(join(request.temp, 'cedarloom-generate-'));
  try {
    // A copy, so the generator reads neither a link nor a FIFO from the project, and writes only into this folder.
    const file = join(folder, 'definition.json');
    writeFileSync(file, definition);
    const out = join(folder, 'out');
    const generator = join(request.root, 'generator', 'generate.mjs');
    const run = spawnSync(process.execPath, [generator, file, '--json', '--prefix', '', '--out', out], {
      cwd: folder,
      env: childEnv(request.env),
      encoding: 'utf8',
      timeout: request.timeoutMs,
      // A generator that ignores SIGTERM would keep the doctor waiting.
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    // ETIMEDOUT and ENOBUFS end the generator, which the outcome reports by its signal.
    const code = errorCode(run.error);
    if (run.error !== undefined && code !== 'ETIMEDOUT' && code !== 'ENOBUFS') throw run.error;
    return outcome(run, out);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};
