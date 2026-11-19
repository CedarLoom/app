import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type AppIo, type Started, start } from './start.ts';

const folders: string[] = [];
const servers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A Git working tree to start in.
const project = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cedarloom-app-')));
  folders.push(root);
  mkdirSync(join(root, '.git'));
  return root;
};

const started = async (argv: string[]) => {
  const out: string[] = [];
  const opened: string[] = [];
  let count = 0;
  const io: AppIo = {
    argv,
    cwd: project(),
    now: () => 0,
    secret: () => `secret-${count++}`,
    open: (url) => opened.push(url),
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
  };
  const result: Started = await start(io);
  if ('close' in result) servers.push(result.close);
  return { result, document: JSON.parse(out.join('')), opened };
};

// One raw HTTP/1.1 request, so no client adds a Host header.
const raw = (port: number, request: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.end(request));
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk;
    });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });

describe('start', () => {
  it('listens on 127.0.0.1, prints the URL with the token as --json, and serves the exchange there', async () => {
    const { document, opened } = await started(['--no-open', '--json']);
    const { port } = document.result;
    expect(document).toEqual({
      result: { url: `http://127.0.0.1:${port}/#t=secret-0`, port },
      findings: [],
      refusals: [],
    });
    expect(opened).toEqual([]);
    const reply = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"token":"secret-0"}',
    });
    expect([reply.status, await reply.json()]).toEqual([200, { csrf: 'secret-2' }]);
    expect(await raw(port, 'GET /api/session HTTP/1.1\r\nConnection: close\r\n\r\n')).toMatch(
      /^HTTP\/1\.1 421 [^]*\r\n\r\n\{"code":"session\.host","params":\{\}\}$/,
    );
  });

  it('refuses a port in use with server.port-in-use, exit 3', async () => {
    const first = await started(['--no-open', '--json']);
    const { port } = first.document.result;
    const second = await started(['--no-open', '--json', '--port', String(port)]);
    expect(second).toEqual({
      result: { exitCode: 3 },
      document: { result: null, findings: [], refusals: [{ code: 'server.port-in-use', params: { port } }] },
      opened: [],
    });
  });
});

describe('bin/cedarloom-app.js', () => {
  it('reports an old Node.js with node.version-unsupported before it loads the rest, exit 1', () => {
    const root = project();
    writeFileSync(join(root, 'old.mjs'), "Object.defineProperty(process.versions, 'node', { value: '24.11.1' });");
    const bin = fileURLToPath(new URL('../bin/cedarloom-app.js', import.meta.url));
    const child = spawnSync(process.execPath, ['--import', './old.mjs', bin, '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    const failed = {
      code: 'node.version-unsupported',
      severity: 'error',
      params: { found: '24.11.1', required: '>=26' },
    };
    expect([child.status, JSON.parse(child.stdout), child.stderr]).toEqual([
      1,
      { result: null, findings: [failed], refusals: [] },
      '',
    ]);
  });
});
