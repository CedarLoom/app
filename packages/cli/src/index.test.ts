import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type PlanOperation, planHash } from '@cedarloom/core';
import { type ApplyRequest, apply, openStore, storeDir } from '@cedarloom/use-cases';
import { afterEach, describe, expect, it } from 'vitest';
import { type Io, main } from './index.ts';

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fresh = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cedarloom-cli-')));
  folders.push(dir);
  return dir;
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const machine = { home: '', platform: process.platform, realpath: realpathSync.native };

// A Git working tree with .claude/, and a state folder of its own.
const project = (): { root: string; state: string } => {
  const root = fresh();
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, '.claude'));
  return { root, state: fresh() };
};

// Records run r1, which created .claude/a.md.
const recorded = (root: string, state: string): void => {
  const dir = storeDir({ ...machine, env: { CEDARLOOM_STATE_DIR: state }, cwd: root, projectRoot: root });
  const store = openStore(dir, { now: () => new Date('2026-11-19T06:00:00.000Z'), newRunId: () => 'r1' });
  if (!store.ok) throw new Error(store.refusal.code);
  const operations: PlanOperation[] = [
    {
      kind: 'create',
      path: '.claude/a.md',
      beforeHash: null,
      afterHash: sha256(Buffer.from('a')),
      before: null,
      after: 'a',
    },
  ];
  const run: ApplyRequest['run'] = {
    kind: 'apply',
    action: 'workflow.new',
    subject: 'a',
    undoes: null,
    generatedFrom: [],
  };
  apply(store.value, { root, plan: { planHash: planHash(operations, sha256), operations, skipped: [] }, run });
  store.value.close();
};

const ran = (argv: string[], cwd: string, change: Partial<Io> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    argv,
    env: { CEDARLOOM_STATE_DIR: change.env?.['CEDARLOOM_STATE_DIR'] ?? fresh() },
    cwd,
    ...machine,
    node: '26.13.0',
    version: '0.0.0',
    required: '>=26',
    clock: { now: () => new Date('2026-11-19T07:00:00.000Z'), newRunId: () => 'u1' },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...change,
  };
  const code = main(io);
  return { code, document: argv.includes('--json') ? JSON.parse(out.join('')) : null, stderr: err.join('') };
};

it.each([
  [[], 'cli.missing-argument', { argument: '<command>', command: 'cedarloom' }],
  [['runs'], 'cli.missing-argument', { argument: '<verb>', command: 'cedarloom runs' }],
  [['runs', 'show'], 'cli.missing-argument', { argument: '<run>', command: 'cedarloom runs show' }],
  [['nope'], 'cli.unknown-command', { command: 'nope', bin: 'cedarloom' }],
  [['runs', 'drop'], 'cli.unknown-command', { command: 'runs drop', bin: 'cedarloom' }],
  [['doctor', 'extra'], 'cli.unknown-command', { command: 'extra', bin: 'cedarloom' }],
  [['doctor', '--yes'], 'cli.unknown-flag', { flag: '--yes', command: 'cedarloom doctor' }],
  [['runs', 'list', '--json=no'], 'cli.bad-value', { flag: '--json', value: 'no' }],
  [['doctor', '--help'], 'cli.flag-conflict', { flags: '--help, --json' }],
  [
    ['doctor', '--plugin-root='],
    'cli.missing-argument',
    { argument: '<dir>', command: 'cedarloom doctor --plugin-root' },
  ],
  [['runs', 'list', '--plugin-root=x'], 'cli.unknown-flag', { flag: '--plugin-root', command: 'cedarloom runs list' }],
])('refuses %j as a usage error, exit 2', (argv, code, params) => {
  const { root } = project();
  expect(ran([...argv, '--json'], root)).toEqual({
    code: 2,
    document: { result: null, findings: [], refusals: [{ code, params }] },
    stderr: '',
  });
});

it('lists no runs for a project without a store, and creates none', () => {
  const { root, state } = project();
  const env = { CEDARLOOM_STATE_DIR: state };
  expect(ran(['runs', 'list', '--json'], root, { env })).toMatchObject({ code: 0, document: { result: { runs: [] } } });
  expect(readdirSync(state)).toEqual([]);
});

it('refuses outside a Git working tree with project.not-found, exit 3', () => {
  const cwd = fresh();
  expect(ran(['runs', 'list', '--json'], cwd).document).toEqual({
    result: null,
    findings: [],
    refusals: [{ code: 'project.not-found', params: { cwd } }],
  });
  expect(ran(['runs', 'list'], cwd).code).toBe(3);
});

it('refuses a run id outside the run id form with run.not-found, exit 3, escaped on standard error', () => {
  const { root } = project();
  expect(ran(['runs', 'show', '../r1', '--json'], root)).toMatchObject({
    code: 3,
    document: { result: null, refusals: [{ code: 'run.not-found', params: { run: '../r1' } }] },
  });
  expect(ran(['runs', 'show', '\u001b[2J\u202e'], root).stderr).toContain('\\u001b[2J\\u202e');
});

it('shows the undo plan without --yes and does not apply it, exit 4; applies it with --yes', () => {
  const { root, state } = project();
  recorded(root, state);
  const env = { CEDARLOOM_STATE_DIR: state };
  const step = { kind: 'delete', path: '.claude/a.md', beforeHash: sha256(Buffer.from('a')), afterHash: null };
  const shown = ran(['undo', 'r1', '--json'], root, { env });
  expect(shown).toMatchObject({
    code: 4,
    document: { result: { plan: { operations: [step] }, applied: false, run: null, generatorRefusals: [] } },
  });
  expect(shown.document.refusals).toEqual([{ code: 'cli.confirm-required', params: {} }]);
  expect(existsSync(join(root, '.claude/a.md'))).toBe(true);
  expect(ran(['undo', 'r1', '--yes', '--json'], root, { env })).toMatchObject({
    code: 0,
    document: { result: { applied: true, run: 'u1' }, refusals: [] },
  });
  expect(existsSync(join(root, '.claude/a.md'))).toBe(false);
  expect(ran(['runs', 'show', 'r1', '--json'], root, { env }).document.result).toMatchObject({
    id: 'r1',
    undoneBy: 'u1',
  });
});

it('fails doctor on an old Node.js with node.version-unsupported, exit 1', () => {
  const { root } = project();
  const failed = {
    code: 'node.version-unsupported',
    severity: 'error',
    params: { found: '24.11.1', required: '>=26' },
  };
  const result = ran(['doctor', '--json'], root, { node: '24.11.1' });
  expect([result.code, result.document.result.checks[0], result.document.findings[0]]).toEqual([
    1,
    { id: 'node', status: 'fail' },
    failed,
  ]);
});

it('looks for the plugin in .claude/plugins of the home folder without CLAUDE_CONFIG_DIR', () => {
  const { root } = project();
  const home = fresh();
  expect(ran(['doctor', '--json'], root, { home }).document.findings).toEqual([
    { code: 'plugin.not-found', severity: 'error', params: { pluginsRoot: join(home, '.claude', 'plugins') } },
  ]);
});

it('reports a crash as cli.internal with the stack on standard error, exit 5', () => {
  const { root } = project();
  const crashed = ran(['runs', 'list', '--json'], root, { realpath: lostDisk });
  expect(crashed).toMatchObject({
    code: 5,
    document: { result: null, refusals: [{ code: 'cli.internal', params: {} }] },
  });
  expect(crashed.stderr).toMatch(/^Error: disk gone\n\s+at /);
});

const bin = fileURLToPath(new URL('../bin/cedarloom.js', import.meta.url));

// The entry in a child process whose standard input is closed at once.
const started = (args: string[], options: { cwd: string; env?: Record<string, string> }) => {
  const child = spawnSync(process.execPath, args, {
    ...options,
    env: { ...process.env, ...options.env },
    input: '',
    encoding: 'utf8',
  });
  return { code: child.status, document: JSON.parse(child.stdout), stderr: child.stderr };
};

const lostDisk = (): string => {
  throw new Error('disk gone');
};

describe('bin/cedarloom.js', () => {
  it('names cedarloom in cli.unknown-command', () => {
    const { root } = project();
    expect(started([bin, 'nope', '--json'], { cwd: root })).toEqual({
      code: 2,
      document: {
        result: null,
        findings: [],
        refusals: [{ code: 'cli.unknown-command', params: { command: 'nope', bin: 'cedarloom' } }],
      },
      stderr: '',
    });
  });

  it('refuses undo without --yes on closed standard input with cli.confirm-required, exit 4', () => {
    const { root, state } = project();
    recorded(root, state);
    const { code, document } = started([bin, 'undo', 'r1', '--json'], {
      cwd: root,
      env: { CEDARLOOM_STATE_DIR: state },
    });
    expect(code).toBe(4);
    expect(document.refusals).toEqual([{ code: 'cli.confirm-required', params: {} }]);
    expect(existsSync(join(root, '.claude/a.md'))).toBe(true);
  });

  it('reports an old Node.js with node.version-unsupported before it loads the rest, exit 1', () => {
    const { root } = project();
    writeFileSync(join(root, 'old.mjs'), "Object.defineProperty(process.versions, 'node', { value: '24.11.1' });");
    const failed = {
      code: 'node.version-unsupported',
      severity: 'error',
      params: { found: '24.11.1', required: '>=26' },
    };
    expect(started(['--import', './old.mjs', bin, 'doctor', '--json'], { cwd: root })).toEqual({
      code: 1,
      document: { result: null, findings: [failed], refusals: [] },
      stderr: '',
    });
  });
});
