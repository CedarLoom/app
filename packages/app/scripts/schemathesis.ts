import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { storeDir } from '@cedarloom/use-cases';
import { z } from 'zod';
import { recordRun } from './recorded-run.ts';

// Runs Schemathesis against cedarloom-app started in a fixture project that holds run r1, with a session of its token.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cedarloom-schemathesis-')));
mkdirSync(join(root, '.git'));
const env = { ...process.env, CEDARLOOM_STATE_DIR: join(root, '.state') };
const machine = { env, platform: process.platform, home: homedir(), cwd: root };
recordRun(root, storeDir({ ...machine, projectRoot: root, realpath: realpathSync.native }));

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const server = spawn(process.execPath, [path('../bin/cedarloom-app.js'), '--no-open', '--json', '--port', '0'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
});
try {
  // A server that exits before its first line fails the run instead of leaving it waiting.
  const [line] = await Promise.race([
    once(createInterface({ input: server.stdout }), 'line'),
    once(server, 'exit').then(([code]) => Promise.reject(new Error(`cedarloom-app exited with ${code}`))),
  ]);
  const { url, port } = JSON.parse(line).result;
  const base = `http://127.0.0.1:${port}`;
  const exchange = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: new URL(url).hash.slice('#t='.length) }),
  });
  if (!exchange.ok) throw new Error(`token exchange answered ${exchange.status}`);
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  const { csrf } = z.object({ csrf: z.string() }).parse(await exchange.json());
  // Every operation documents its 4XX answers, so a run whose cookie the server refuses would still pass.
  const session = await fetch(`${base}/api/session`, { headers: { cookie: cookie ?? '' } });
  if (session.status !== 200) throw new Error(`GET /api/session with the cookie answered ${session.status}`);
  // unsupported_method expects 405 with Allow; the server answers every method it does not route with 404 api.not-found.
  const checks = ['--checks', 'all', '--exclude-checks', 'unsupported_method'];
  const headers = ['-H', `Cookie: ${cookie}`, '-H', `x-cedarloom-csrf: ${csrf}`, '-H', `Host: 127.0.0.1:${port}`];
  const run = spawnSync('schemathesis', ['run', path('../openapi.json'), '--url', base, ...headers, ...checks], {
    cwd: root,
    stdio: 'inherit',
  });
  if (run.error !== undefined) throw run.error;
  process.exitCode = run.status ?? 1;
} finally {
  server.kill();
}
