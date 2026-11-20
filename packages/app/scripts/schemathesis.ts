import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { storeDir } from '@cedarloom/use-cases';
import { z } from 'zod';
import { recordRun } from './recorded-run.ts';

// Runs Schemathesis against cedarloom-app started in a fixture project that holds run r1, with a session of its token.
// Each undo case gets a run recorded for it (schemathesis_hooks.py asks the fixture server below), as an undo settles its run.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cedarloom-schemathesis-')));
mkdirSync(join(root, '.git'));
const env = { ...process.env, CEDARLOOM_STATE_DIR: join(root, '.state') };
const machine = { env, platform: process.platform, home: homedir(), cwd: root };
const store = storeDir({ ...machine, projectRoot: root, realpath: realpathSync.native });
recordRun(root, store);

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const fixtures = createServer();
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
  // Every operation documents its 4XX answers, so a run whose cookie or CSRF header the server refuses would still pass.
  const credentials = { cookie: cookie ?? '', 'x-cedarloom-csrf': csrf };
  const session = await fetch(`${base}/api/session`, { headers: credentials });
  if (session.status !== 200) throw new Error(`GET /api/session with the cookie answered ${session.status}`);
  // Only unsafe methods check the CSRF header; an undo of a run that does not exist passes it and answers 404.
  const unsafe = await fetch(`${base}/api/runs/none/undo`, {
    method: 'POST',
    headers: { ...credentials, 'content-type': 'application/json' },
    body: JSON.stringify({ planHash: '0'.repeat(64) }),
  });
  if (unsafe.status !== 404) throw new Error(`POST /api/runs/none/undo with the CSRF header answered ${unsafe.status}`);
  let recorded = 0;
  fixtures.on('request', async (_request, reply) => {
    try {
      const id = `u${++recorded}`;
      recordRun(root, store, id, `${id}.md`);
      const preview = await fetch(`${base}/api/runs/${id}/undo`, { headers: { cookie: cookie ?? '' } });
      if (!preview.ok) throw new Error(`GET /api/runs/${id}/undo answered ${preview.status}`);
      const { planHash } = z.object({ planHash: z.string() }).parse(await preview.json());
      reply.end(JSON.stringify({ id, planHash }));
    } catch (error) {
      console.error(error);
      reply.writeHead(500).end(String(error));
    }
  });
  fixtures.listen(0, '127.0.0.1');
  await once(fixtures, 'listening');
  const fixtureUrl = `http://127.0.0.1:${z.object({ port: z.number() }).parse(fixtures.address()).port}`;
  // unsupported_method expects 405 with Allow; the server answers every method it does not route with 404 api.not-found.
  const checks = ['--checks', 'all', '--exclude-checks', 'unsupported_method'];
  const headers = ['-H', `Cookie: ${cookie}`, '-H', `x-cedarloom-csrf: ${csrf}`, '-H', `Host: 127.0.0.1:${port}`];
  const hooked = { ...env, SCHEMATHESIS_HOOKS: path('schemathesis_hooks.py'), CEDARLOOM_FIXTURES: fixtureUrl };
  const run = spawn('schemathesis', ['run', path('../openapi.json'), '--url', base, ...headers, ...checks], {
    cwd: root,
    env: hooked,
    stdio: 'inherit',
  });
  const [code] = await once(run, 'exit');
  process.exitCode = code ?? 1;
  // The hooks record a run for each undo case; none recorded means they stopped firing and the undo route went untested.
  if (recorded === 0) {
    console.error('schemathesis_hooks.py recorded no run');
    process.exitCode = 1;
  }
} finally {
  fixtures.close();
  server.kill();
}
