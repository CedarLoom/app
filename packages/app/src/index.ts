import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { start } from './start.ts';

// The platform's own opener; cmd's start takes its first quoted word as a window title, hence the empty one.
const OPENERS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['open'],
  win32: ['cmd', '/c', 'start', '""'],
};

const openBrowser = (url: string): void => {
  const [command = 'xdg-open', ...args] = OPENERS[process.platform] ?? [];
  const child = spawn(command, [...args, url], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: process.platform === 'win32',
  });
  child.on('error', (error) => process.stderr.write(`${error.message}\n`));
  child.unref();
};

const crashed = (error: unknown): void => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  const refusal = { code: 'cli.internal', params: {} };
  if (process.argv.includes('--json'))
    process.stdout.write(`${JSON.stringify({ result: null, findings: [], refusals: [refusal] })}\n`);
  process.exitCode = 5;
};

/** The bin's entry: serves until SIGINT or SIGTERM, then closes the server and exits 0. */
export const run = (): void => {
  start({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    // Monotonic, so a change of the system clock does not stretch or cut the token's 10 minutes.
    now: () => performance.now(),
    secret: () => randomBytes(32).toString('base64url'),
    open: openBrowser,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then((started) => {
    if ('exitCode' in started) {
      process.exitCode = started.exitCode;
      return;
    }
    const stop = (): void => {
      started.close().then(() => {
        process.exitCode = 0;
      }, crashed);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }, crashed);
};
