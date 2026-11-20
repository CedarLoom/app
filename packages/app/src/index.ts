import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printable } from '@cedarloom/core';
import { storeDir } from '@cedarloom/use-cases';
import manifest from '../package.json' with { type: 'json' };
import { opener } from './opener.ts';
import { type AppIo, crashed, type Started, start } from './start.ts';

const openFile = (path: string): void => {
  const { command, args } = opener(process.platform, process.env['SystemRoot'], path);
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: process.platform === 'win32',
  });
  child.on('error', (error) => process.stderr.write(`${printable(error.message)}\n`));
  child.unref();
};

/** What a listening server needs of its process: the signals that stop it, and the exit with a code. */
export interface Host {
  once: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void;
  exit: (exitCode: number) => void;
}

/** Closes the server on the first SIGINT or SIGTERM, then exits with the close's code; a failed close may hold the process open. */
export const closeOnSignal = (started: Exclude<Started, { exitCode: number }>, host: Host): void => {
  let closing = false;
  // One close only: a SIGTERM after a SIGINT would close twice and could exit with the second close's code.
  const stop = (): void => {
    if (closing) return;
    closing = true;
    void started.close().then(host.exit);
  };
  host.once('SIGINT', stop);
  host.once('SIGTERM', stop);
};

// An exit drops what a pipe has not taken yet, so it waits for the writes before it on stdout and stderr.
const exit = (exitCode: number): void => {
  process.exitCode = exitCode;
  process.stdout.write('', () => process.stderr.write('', () => process.exit()));
};

/** The bin's entry: serves until SIGINT or SIGTERM, then closes the server and exits with the close's code. */
export const run = (): void => {
  const home = homedir();
  // The store's parent, so a relative CEDARLOOM_STATE_DIR places the page and the store from the same project root.
  const store = (projectRoot: string): string =>
    storeDir({
      env: process.env,
      platform: process.platform,
      home,
      cwd: projectRoot,
      projectRoot,
      realpath: realpathSync.native,
    });
  const io: AppIo = {
    argv: process.argv.slice(2),
    get cwd() {
      return process.cwd();
    },
    env: process.env,
    home,
    stateDir: (projectRoot) => dirname(store(projectRoot)),
    storeDir: store,
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
  };
  start(io).then(
    (started) => {
      if ('exitCode' in started) process.exitCode = started.exitCode;
      else closeOnSignal(started, { once: (signal, listener) => process.once(signal, listener), exit });
    },
    (error: unknown) => {
      process.exitCode = crashed(io, error);
    },
  );
};
