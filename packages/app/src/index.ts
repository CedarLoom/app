import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { printableLines } from '@cedarloom/core';
import { stateDir, storeDir } from '@cedarloom/use-cases';
import manifest from '../package.json' with { type: 'json' };
import { opener } from './opener.ts';
import { start } from './start.ts';

const openFile = (path: string): void => {
  const { command, args } = opener(process.platform, process.env['SystemRoot'], path);
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: process.platform === 'win32',
  });
  child.on('error', (error) => process.stderr.write(`${printableLines(error.message)}\n`));
  child.unref();
};

const crashed = (error: unknown): void => {
  process.stderr.write(`${printableLines(String(error instanceof Error ? error.stack : error))}\n`);
  const refusal = { code: 'cli.internal', params: {} };
  if (process.argv.includes('--json'))
    process.stdout.write(`${JSON.stringify({ result: null, findings: [], refusals: [refusal] })}\n`);
  process.exitCode = 5;
};

/** The bin's entry: serves until SIGINT or SIGTERM, then closes the server and exits 0. */
export const run = (): void => {
  const machine = { env: process.env, platform: process.platform, home: homedir(), cwd: process.cwd() };
  start({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    home: homedir(),
    stateDir: stateDir(machine),
    storeDir: (projectRoot) => storeDir({ ...machine, projectRoot, realpath: realpathSync.native }),
    uiDir: fileURLToPath(new URL('../dist/ui', import.meta.url)),
    clock: { now: () => new Date(), newRunId: randomUUID },
    node: process.versions.node,
    required: manifest.engines.node,
    version: manifest.version,
    // Monotonic, so a change of the system clock does not stretch or cut the token's 10 minutes.
    now: () => performance.now(),
    secret: () => randomBytes(32).toString('base64url'),
    open: openFile,
    platform: process.platform,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then((started) => {
    if ('exitCode' in started) {
      process.exitCode = started.exitCode;
      return;
    }
    const stop = (): void => {
      void started.close().then((exitCode) => {
        process.exitCode = exitCode;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }, crashed);
};
