import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { connect, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeRedirect } from './redirect.ts';
import { type AppIo, closed, crashed, openPage, type Started, start } from './start.ts';

// A server built while error is set fails to close with it; a throwing onClose hook would escape uncaught instead.
const closing = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock('./server.ts', async (original) => {
  const server = await original<typeof import('./server.ts')>();
  const buildServer: typeof server.buildServer = async (options) => {
    const app = await server.buildServer(options);
    const { error } = closing;
    if (error !== undefined) app.addHook('onClose', () => Promise.reject(error));
    return app;
  };
  return { ...server, buildServer };
});

const folders: string[] = [];
const servers: (() => Promise<number>)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const folder = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'cedarloom-app-')));
  folders.push(path);
  return path;
};

// A Git working tree to start in.
const project = (): string => {
  const root = folder();
  mkdirSync(join(root, '.git'));
  return root;
};

const appIo = (argv: string[], open?: (path: string) => void) => {
  const out: string[] = [];
  const errors: string[] = [];
  const opened: string[] = [];
  let count = 0;
  const state = folder();
  const io: AppIo = {
    argv,
    cwd: project(),
    env: {},
    home: state,
    stateDir: () => state,
    storeDir: () => folder(),
    uiDir: join(state, 'ui'),
    clock: { now: () => new Date(0), newRunId: () => 'r1' },
    node: '26.13.0',
    required: '>=26',
    version: '1.2.3',
    now: () => 0,
    secret: () => `secret-${count++}`,
    open: open ?? ((path) => opened.push(path)),
    platform: process.platform,
    stdout: (text) => out.push(text),
    stderr: (text) => errors.push(text),
  };
  return { io, out, errors, opened, state };
};

const started = async (argv: string[], open?: (path: string) => void) => {
  const { io, out, errors, opened, state } = appIo(argv, open);
  const result: Started = await start(io);
  if ('close' in result) servers.push(result.close);
  return { result, document: JSON.parse(out.join('')), errors, opened, state };
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

// Each bind fails with this system code, so start stops without listening.
const failingBind = (code: string, syscall = 'listen') =>
  vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) {
    process.nextTick(() => this.emit('error', Object.assign(new Error(code), { code, syscall })));
    return this;
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
      errors: [],
      opened: [],
      state: expect.any(String),
    });
  });

  it('reports an opener that throws on stderr and keeps serving', async () => {
    const { result, document, errors } = await started(['--json'], () => {
      throw new Error('no browser\u202e');
    });
    expect(['close' in result, document.refusals, errors]).toEqual([true, [], ['no browser\\u202e\n']]);
  });
});

describe('start, the redirect page', () => {
  it('opens a page in the state folder that refreshes to the URL, so no opener argument holds the token', async () => {
    const { document, opened, state } = await started(['--json']);
    const { port } = document.result;
    expect([opened.length, dirname(dirname(opened[0] ?? ''))]).toEqual([1, state]);
    expect(opened[0]).not.toContain('secret-0');
    expect(readFileSync(opened[0] ?? '', 'utf8')).toContain(
      `<meta http-equiv="refresh" content="0;url=http://127.0.0.1:${port}/#t=secret-0">`,
    );
  });

  it('removes the page once the token is exchanged', async () => {
    const { document, opened } = await started(['--json']);
    const reply = await fetch(`http://127.0.0.1:${document.result.port}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"token":"secret-0"}',
    });
    expect([reply.status, opened.length, existsSync(opened[0] ?? '')]).toEqual([200, 1, false]);
  });

  it('removes the page when the server closes', async () => {
    const { result, opened } = await started(['--json']);
    if ('close' in result) await result.close();
    expect([opened.length, existsSync(opened[0] ?? '')]).toEqual([1, false]);
  });
});

// The clock reads 2026-01-01T00:00:00Z, which is 1_767_225_600 s; 10 minutes before is 1_767_225_000 s.
const pageIo = (stateDir: string) => ({
  stateDir: () => stateDir,
  open: () => undefined,
  platform: 'darwin' as const,
  stderr: () => undefined,
  clock: { now: () => new Date('2026-01-01T00:00:00Z'), newRunId: () => 'r1' },
});

// A page an earlier start wrote, its folder changed at `seconds` since the epoch.
const earlier = (state: string, seconds: number): string => {
  const { path } = writeRedirect(state, 'http://127.0.0.1:4000/#t=old');
  utimesSync(dirname(path), seconds, seconds);
  return path;
};

describe('openPage', () => {
  it.each([
    ['linux', false, 1],
    ['darwin', false, 0],
    ['win32', false, 0],
    ['linux', true, 0],
  ] as const)('after opening the page on %s, --json %s, prints %i line(s) on stderr', (platform, json, lines) => {
    const errors: string[] = [];
    const io = { ...pageIo(folder()), platform, stderr: (text: string) => errors.push(text) };
    openPage(io, '/project', 'http://127.0.0.1:4000/#t=abc', json);
    expect(errors).toHaveLength(lines);
  });

  it('removes the page of a start more than 10 minutes ago, keeps a younger one and its own', () => {
    const state = folder();
    const pages = [earlier(state, 1_767_224_999), earlier(state, 1_767_225_001)];
    openPage(pageIo(state), '/project', 'http://127.0.0.1:4000/#t=abc', true);
    expect([pages.map((page) => existsSync(page)), readdirSync(state).length]).toEqual([[false, true], 2]);
  });

  it('keeps its own page when the clock runs more than 10 minutes ahead of the state folder', () => {
    const state = folder();
    const clock = { now: () => new Date('2100-01-01T00:00:00Z'), newRunId: () => 'r1' };
    openPage({ ...pageIo(state), clock }, '/project', 'http://127.0.0.1:4000/#t=abc', true);
    expect(readdirSync(state).map((name) => readdirSync(join(state, name)))).toEqual([['cedarloom-app.html']]);
  });
});

describe('closed', () => {
  it('ends the start of a server that fails to close with the stack escaped on stderr, exit 5', async () => {
    const { io, errors } = appIo(['--no-open', '--json']);
    closing.error = Object.assign(new Error('close failed'), { stack: 'Error: close\u202e failed\n    at close' });
    const result = await start(io).finally(() => {
      closing.error = undefined;
    });
    expect(['close' in result && (await result.close()), errors]).toEqual([
      5,
      ['Error: close\\u202e failed\n    at close\n'],
    ]);
  });

  it('reports a failed close by its stack, escaped, on stderr and no second document, exit 5', async () => {
    const { io, out, errors } = appIo(['--json']);
    const failure = Object.assign(new Error('close failed'), { stack: 'Error: close\u202e failed\n    at close' });
    expect([await closed(io, Promise.reject(failure)), out, errors]).toEqual([
      5,
      [],
      ['Error: close\\u202e failed\n    at close\n'],
    ]);
  });
});

describe('start without a server', () => {
  it('binds 127.0.0.1 only', async () => {
    const listen = failingBind('EADDRINUSE');
    try {
      await started(['--no-open', '--json']);
      expect(listen.mock.calls.map(([options]) => options)).toEqual([expect.objectContaining({ host: '127.0.0.1' })]);
    } finally {
      listen.mockRestore();
    }
  });

  it.each(['EACCES', 'EADDRNOTAVAIL'])(
    'refuses a bind failing with %s with server.listen-failed, exit 3',
    async (code) => {
      const listen = failingBind(code);
      try {
        const { result, document } = await started(['--no-open', '--json']);
        const refusal = { code: 'server.listen-failed', params: { port: 0, error: code } };
        expect([result, document.refusals]).toEqual([{ exitCode: 3 }, [refusal]]);
      } finally {
        listen.mockRestore();
      }
    },
  );

  it('lets a system error of another syscall than listen propagate', async () => {
    const listen = failingBind('ENOENT', 'open');
    const starting = start(appIo(['--no-open', '--json']).io).finally(() => listen.mockRestore());
    await expect(starting).rejects.toThrow('ENOENT');
  });

  it.each(['--port 80', '--port=80'])('refuses %s with cli.bad-value, exit 2', async (words) => {
    expect(await started(['--json', ...words.split(' ')])).toEqual({
      result: { exitCode: 2 },
      document: {
        result: null,
        findings: [],
        refusals: [{ code: 'cli.bad-value', params: { flag: '--port', value: '80' } }],
      },
      errors: [],
      opened: [],
      state: expect.any(String),
    });
  });

  it.each([
    ['--plugin-root', '--no-open', '<dir>'],
    ['--port', '--json', '<n>'],
  ])('refuses %s followed by %s with cli.missing-argument, exit 2', async (flag, next, argument) => {
    const { result, document } = await started(['--json', flag, next]);
    const params = { argument, command: `cedarloom-app ${flag}` };
    expect([result, document.refusals]).toEqual([{ exitCode: 2 }, [{ code: 'cli.missing-argument', params }]]);
  });
});

describe('start, the --json document', () => {
  it('escapes a format character of a refused value in the --json document, equal after parsing', async () => {
    const { io, out } = appIo(['--json', '--port=\u202e']);
    await start(io);
    expect([out.join(''), JSON.parse(out.join('')).refusals[0].params.value]).toEqual([
      expect.stringContaining('"value":"\\u202e"'),
      '\u202e',
    ]);
  });
});

describe('crashed', () => {
  // The message escaped apart from the frames, and the cause with its own stack.
  const stack = expect.stringMatching(
    /^Error: lost\\u000a    at forged\n {4}at [^]*\n\[cause\]: Error: disk gone\n {4}at /,
  );
  it.each([
    ['--json', ['{"result":null,"findings":[],"refusals":[{"code":"cli.internal","params":{}}]}\n'], []],
    // cli.internal as one line of text after the stack.
    ['text', [], [expect.stringMatching(/^\S[^\n]*\n$/)]],
  ])('reports a crash in %s mode by its stack and cli.internal, exit 5', (mode, document, text) => {
    const { io, out, errors } = appIo(mode === 'text' ? [] : [mode]);
    const error = new Error('lost\n    at forged', { cause: new Error('disk gone') });
    expect([crashed(io, error), out, errors]).toEqual([5, document, [stack, ...text]]);
  });
});

describe('start, usage and version', () => {
  it.each([
    ['extra', 'extra'],
    ['', "''"],
  ])('refuses the word %j with cli.surplus-argument, exit 2', async (word, argument) => {
    const { result, document } = await started(['--json', word]);
    const refusal = { code: 'cli.surplus-argument', params: { argument, command: 'cedarloom-app' } };
    expect([result, document.refusals]).toEqual([{ exitCode: 2 }, [refusal]]);
  });

  it.each(['--help', '-h'])('prints the usage for %s on stdout, exit 0', async (flag) => {
    const { io, out, errors } = appIo([flag]);
    expect([await start(io), out.join('') === '', errors]).toEqual([{ exitCode: 0 }, false, []]);
  });

  it('refuses --help with --json with cli.flag-conflict, exit 2', async () => {
    const { result, document } = await started(['--help', '--json']);
    const refusal = { code: 'cli.flag-conflict', params: { flags: '--help, --json' } };
    expect([result, document.refusals]).toEqual([{ exitCode: 2 }, [refusal]]);
  });

  it.each(['--version', '-V'])('prints the version for %s alone on stdout, exit 0', async (flag) => {
    const { io, out, errors } = appIo([flag]);
    expect([await start(io), out, errors]).toEqual([{ exitCode: 0 }, ['1.2.3\n'], []]);
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

// Runs the bin in a project with a module loaded before it, which breaks one part of the process.
const binWith = (preload: string, words: string[]) => {
  const root = project();
  writeFileSync(join(root, 'preload.mjs'), preload);
  const bin = fileURLToPath(new URL('../bin/cedarloom-app.js', import.meta.url));
  return spawnSync(process.execPath, ['--import', './preload.mjs', bin, ...words], { cwd: root, encoding: 'utf8' });
};

describe('bin/cedarloom-app.js, broken by a preload', () => {
  it('reports a throw inside run by its stack, escaped, and cli.internal, exit 5', () => {
    const child = binWith(
      [
        "import os from 'node:os';",
        "import { syncBuiltinESMExports } from 'node:module';",
        "os.homedir = () => { throw new Error('lost\\n    at forged'); };",
        'syncBuiltinESMExports();',
      ].join('\n'),
      ['--json'],
    );
    expect([child.status, JSON.parse(child.stdout), child.stderr]).toEqual([
      5,
      { result: null, findings: [], refusals: [{ code: 'cli.internal', params: {} }] },
      expect.stringMatching(/^Error: lost\\u000a {4}at forged\n {4}at /),
    ]);
  });

  describe('in a removed working folder', () => {
    const gone = "process.cwd = () => { throw new Error('ENOENT: uv_cwd'); };";

    it('prints the version, exit 0', () => {
      const child = binWith(gone, ['--version']);
      expect([child.status, child.stdout, child.stderr]).toEqual([0, '0.0.0\n', '']);
    });

    it('refuses with project.not-found, exit 3', () => {
      const child = binWith(gone, ['--json']);
      const refusal = { code: 'project.not-found', params: { cwd: '.' } };
      expect([child.status, JSON.parse(child.stdout).refusals]).toEqual([3, [refusal]]);
    });
  });
});
