import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
    // A home of its own, so no doctor run reads the plugins or settings of the checkout it runs in.
    home: fresh(),
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
  [['runs list'], 'cli.unknown-command', { command: 'runs list', bin: 'cedarloom' }],
  [['runs', 'show', ''], 'cli.missing-argument', { argument: '<run>', command: 'cedarloom runs show' }],
  [['--version'], 'cli.flag-conflict', { flags: '--version, --json' }],
  [['-V', '--help'], 'cli.flag-conflict', { flags: '-V, --help' }],
  [['doctor', 'extra'], 'cli.surplus-argument', { argument: 'extra', command: 'cedarloom doctor' }],
  [['doctor', '--yes'], 'cli.unknown-flag', { flag: '--yes', command: 'cedarloom doctor' }],
  [['runs', 'list', '--json=no'], 'cli.bad-value', { flag: '--json', value: 'no' }],
  [['doctor', '--help'], 'cli.flag-conflict', { flags: '--help, --json' }],
  [
    ['doctor', '--plugin-root='],
    'cli.missing-argument',
    { argument: '<dir>', command: 'cedarloom doctor --plugin-root' },
  ],
  [
    ['doctor', '--plugin-root'],
    'cli.missing-argument',
    { argument: '<dir>', command: 'cedarloom doctor --plugin-root' },
  ],
  [
    ['doctor', '--plugin-root', '--yes'],
    'cli.missing-argument',
    { argument: '<dir>', command: 'cedarloom doctor --plugin-root' },
  ],
  [['runs', 'list', '--plugin-root=x'], 'cli.unknown-flag', { flag: '--plugin-root', command: 'cedarloom runs list' }],
  [['workflows'], 'cli.missing-argument', { argument: '<verb>', command: 'cedarloom workflows' }],
  [['workflows', 'show'], 'cli.missing-argument', { argument: '<name>', command: 'cedarloom workflows show' }],
  [['workflows', 'list', '--shipped'], 'cli.unknown-flag', { flag: '--shipped', command: 'cedarloom workflows list' }],
  [
    ['workflows', 'new', 'mine', '--from'],
    'cli.missing-argument',
    { argument: '<shipped>', command: 'cedarloom workflows new --from' },
  ],
  [['workflows', 'set', 'mine', '/model', 'opus'], 'cli.value-not-json', { argument: '<value>' }],
  [['workflows', 'set', 'mine', '/model', '1', '--unset'], 'cli.flag-conflict', { flags: '<value>, --unset' }],
  [
    ['workflows', 'set', 'mine', '/model'],
    'cli.missing-argument',
    { argument: '<value>', command: 'cedarloom workflows set' },
  ],
  [
    ['workflows', 'move', 'mine', '/stages/0'],
    'cli.missing-argument',
    { argument: '<to>', command: 'cedarloom workflows move' },
  ],
  [
    ['workflows', 'remove', 'mine', '/stages/0', 'x'],
    'cli.surplus-argument',
    { argument: 'x', command: 'cedarloom workflows remove' },
  ],
  [
    ['workflows', 'add', 'mine', '/stages/-', '{}', '--unset'],
    'cli.unknown-flag',
    { flag: '--unset', command: 'cedarloom workflows add' },
  ],
  [
    ['workflows', 'generate', '--from=dev'],
    'cli.unknown-flag',
    { flag: '--from', command: 'cedarloom workflows generate' },
  ],
  [['workflows', 'off'], 'cli.missing-argument', { argument: '<id>', command: 'cedarloom workflows off' }],
  [
    ['workflows', 'off', 'dev', 'plain'],
    'cli.surplus-argument',
    { argument: 'plain', command: 'cedarloom workflows off' },
  ],
  [['workflows', 'off', 'dev', '--plugin'], 'cli.flag-conflict', { flags: '<id>, --plugin' }],
  [['workflows', 'off', '--plugin', '--script-only'], 'cli.flag-conflict', { flags: '--script-only, --plugin' }],
  [['workflows', 'off', '--plugin', '--plugin-root', 'x'], 'cli.flag-conflict', { flags: '--plugin-root, --plugin' }],
  [
    ['workflows', 'on', 'dev', 'plain'],
    'cli.surplus-argument',
    { argument: 'plain', command: 'cedarloom workflows on' },
  ],
  [
    ['workflows', 'on', 'dev', '--script-only'],
    'cli.unknown-flag',
    { flag: '--script-only', command: 'cedarloom workflows on' },
  ],
  [
    ['workflows', 'on', 'dev', '--plugin-root=x'],
    'cli.unknown-flag',
    { flag: '--plugin-root', command: 'cedarloom workflows on' },
  ],
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

it.each([[['runs', 'show']], [['undo']]])('checks the project before the run id with %j', (words) => {
  const cwd = fresh();
  expect(ran([...words, '../r1', '--json'], cwd).document.refusals).toEqual([
    { code: 'project.not-found', params: { cwd } },
  ]);
});

it('refuses a malformed run id before it opens the store', () => {
  const { root, state } = project();
  expect(ran(['undo', '../r1'], root, { env: { CEDARLOOM_STATE_DIR: state } }).code).toBe(3);
  expect(readdirSync(state)).toEqual([]);
});

it('refuses a surplus word also with --help, exit 2', () => {
  const { root } = project();
  expect(ran(['doctor', 'extra', '--help'], root).code).toBe(2);
});

it('refuses a run id outside the run id form with run.not-found, exit 3, escaped on standard error', () => {
  const { root } = project();
  expect(ran(['runs', 'show', '../r1', '--json'], root)).toMatchObject({
    code: 3,
    document: { result: null, refusals: [{ code: 'run.not-found', params: { run: '../r1' } }] },
  });
  expect(ran(['runs', 'show', '\u001b[2J\u202e\u2028\u{e0001}'], root).stderr).toContain(
    '\\u001b[2J\\u202e\\u2028\\udb40\\udc01',
  );
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

it('reports a crash as cli.internal with the stack escaped on standard error, exit 5', () => {
  const { root } = project();
  const crashed = ran(['runs', 'list', '--json'], root, { realpath: lostDisk });
  expect(crashed).toMatchObject({
    code: 5,
    document: { result: null, refusals: [{ code: 'cli.internal', params: {} }] },
  });
  expect(crashed.stderr).toMatch(/^Error: disk gone\\u202e\n\s+at /);
});

it('prints the cause of a crash with its stack', () => {
  const { root } = project();
  expect(ran(['runs', 'list', '--json'], root, { realpath: stoppedRun }).stderr).toMatch(
    /\[cause\]: Error: disk gone\n\s+at /,
  );
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
  return {
    code: child.status,
    document: args.includes('--json') ? JSON.parse(child.stdout) : child.stdout,
    stderr: child.stderr,
  };
};

const lostDisk = (): string => {
  throw new Error('disk gone\u202e');
};

const stoppedRun = (): string => {
  throw new Error('run r1 stopped', { cause: new Error('disk gone') });
};

describe('bin/cedarloom.js', () => {
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

  it('ends with the code cli.internal, exit 5, when its packages do not load', () => {
    const { root } = project();
    writeFileSync(
      join(root, 'missing.mjs'),
      "import { registerHooks } from 'node:module';\n" +
        "registerHooks({ resolve: (name, context, next) => { if (name.startsWith('@cedarloom/')) throw new Error('missing'); return next(name, context); } });",
    );
    const { code, stderr } = started(['--import', './missing.mjs', bin, 'doctor'], { cwd: root });
    expect([code, stderr.endsWith('\ncli.internal\n')]).toEqual([5, true]);
  });
});

describe('bin/cedarloom.js in its working folder', () => {
  // Windows cannot remove the working folder of a running process.
  it.skipIf(process.platform === 'win32')('answers --version in a removed working folder', () => {
    const { root } = project();
    const gone = join(root, 'gone');
    mkdirSync(gone);
    writeFileSync(
      join(root, 'gone.mjs'),
      `import { rmdirSync } from 'node:fs';\nprocess.chdir(${JSON.stringify(gone)});\nrmdirSync(${JSON.stringify(gone)});`,
    );
    expect(started(['--import', './gone.mjs', bin, '--version'], { cwd: root })).toEqual({
      code: 0,
      document: '0.0.0\n',
      stderr: '',
    });
  });

  // The store folder is named by the project's real path, which on Windows, unlike the working folder, has the case on disk.
  it.runIf(process.platform === 'win32')('finds the store of a project from a working folder in other case', () => {
    const { root, state } = project();
    recorded(root, state);
    const { code, document } = started([bin, 'runs', 'show', 'r1', '--json'], {
      cwd: root.toUpperCase(),
      env: { CEDARLOOM_STATE_DIR: state },
    });
    expect([code, document.result.id]).toEqual([0, 'r1']);
  });
});

// A generator in the plugin's form: with --json it prints a refusal per entry of a definition's "refusals" and exits 1;
// else it writes each file of a definition's "writes" below --out.
const GENERATOR = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const refusals = [];
const writes = [];
for (const file of args.slice(0, args.indexOf('--json'))) {
  const definition = JSON.parse(readFileSync(file, 'utf8'));
  for (const field of definition.refusals ?? []) refusals.push({ file, field, rule: 'refused' });
  writes.push(...Object.entries(definition.writes ?? {}));
}
console.log(JSON.stringify(refusals));
process.exitCode = refusals.length ? 1 : 0;
const out = args[args.indexOf('--out') + 1];
for (const [path, text] of refusals.length ? [] : writes) {
  mkdirSync(join(out, path, '..'), { recursive: true });
  writeFileSync(join(out, path), text);
}
`;
const DEV = '{"name":"dev","description":"Shipped dev.","stages":[{"id":"change","phases":[]}]}';

// A project with the definitions given and a plugin folder with the shipped definition dev and, unless left out, its generator.
const workflowsSetup = (definitions: Record<string, string>, generator = true) => {
  const { root } = project();
  const plugin = fresh();
  mkdirSync(join(plugin, 'definitions'));
  writeFileSync(join(plugin, 'definitions', 'dev.json'), DEV);
  if (generator) {
    mkdirSync(join(plugin, 'generator'));
    writeFileSync(join(plugin, 'generator', 'generate.mjs'), GENERATOR);
  }
  mkdirSync(join(root, '.cedarloom', 'workflows'), { recursive: true });
  for (const [name, text] of Object.entries(definitions)) {
    writeFileSync(join(root, '.cedarloom', 'workflows', `${name}.json`), text);
  }
  const workflows = (...argv: string[]) => ran(['workflows', ...argv, '--plugin-root', plugin, '--json'], root);
  return { root, plugin, workflows };
};

it('lists with workflows list the shipped and the project definitions, each with its source', () => {
  const { plugin, workflows } = workflowsSetup({ mine: '{"description":"Mine."}', odd: '{' });
  expect(workflows('list')).toMatchObject({
    code: 0,
    document: {
      result: {
        workflows: [
          {
            name: 'dev',
            source: 'shipped',
            path: join(plugin, 'definitions', 'dev.json'),
            description: 'Shipped dev.',
          },
          { name: 'mine', source: 'project', path: '.cedarloom/workflows/mine.json', description: 'Mine.' },
          { name: 'odd', source: 'project', path: '.cedarloom/workflows/odd.json', description: null },
        ],
      },
      refusals: [],
    },
  });
});

it('shows a definition with workflows show, and refuses an unknown name with definition.not-found, exit 3', () => {
  const { workflows } = workflowsSetup({ mine: '{"stages":[]}' });
  expect(workflows('show', 'mine')).toMatchObject({
    code: 0,
    document: {
      result: {
        name: 'mine',
        source: 'project',
        path: '.cedarloom/workflows/mine.json',
        hash: 'a6fe3f2921edcece5f4978137ccd3109d72e5d5411367c42f3bf629372187879',
        definition: { stages: [] },
      },
    },
  });
  expect(workflows('show', 'dev')).toEqual({
    code: 3,
    document: {
      result: null,
      findings: [],
      refusals: [{ code: 'definition.not-found', params: { name: 'dev', source: 'project' } }],
    },
    stderr: '',
  });
});

it('passes a valid definition in workflows validate, exit 0', () => {
  const { workflows } = workflowsSetup({ mine: '{}' });
  expect(workflows('validate', 'mine')).toMatchObject({
    code: 0,
    document: { result: { definitions: [{ name: 'mine', source: 'project', generatorRefusals: [], refusals: [] }] } },
  });
});

it("reports in workflows validate the generator's file, field and rule of an invalid definition, exit 1", () => {
  const { workflows } = workflowsSetup({ bad: '{"refusals":["stages[0].id"]}', mine: '{}' });
  expect(workflows('validate')).toMatchObject({
    code: 1,
    document: {
      result: {
        definitions: [
          {
            name: 'bad',
            source: 'project',
            generatorRefusals: [{ file: '.cedarloom/workflows/bad.json', field: 'stages[0].id', rule: 'refused' }],
            refusals: [],
          },
          { name: 'mine', source: 'project', generatorRefusals: [], refusals: [] },
        ],
      },
      refusals: [],
    },
  });
});

it('refuses in workflows validate a definition whose name is not its file name, without generating it, exit 1', () => {
  const { workflows } = workflowsSetup({ mine: '{"name":"dev","refusals":["stages"]}' });
  expect(workflows('validate', 'mine')).toMatchObject({
    code: 1,
    document: {
      result: {
        definitions: [
          {
            name: 'mine',
            source: 'project',
            generatorRefusals: [],
            refusals: [
              { code: 'definition.name-mismatch', params: { file: '.cedarloom/workflows/mine.json', name: 'dev' } },
            ],
          },
        ],
      },
      refusals: [],
    },
  });
});

it('refuses validate without a generator with plugin.too-old, exit 3, and lists the project definitions, exit 1', () => {
  const { plugin, workflows } = workflowsSetup({ mine: '{}' }, false);
  const tooOld = { code: 'plugin.too-old', params: { root: plugin, version: null } };
  expect(workflows('validate')).toMatchObject({ code: 3, document: { result: null, refusals: [tooOld] } });
  expect(workflows('list')).toMatchObject({
    code: 1,
    document: {
      result: { workflows: [{ name: 'mine', source: 'project' }] },
      findings: [{ code: 'plugin.trust-bypassed' }, { ...tooOld, severity: 'error' }],
      refusals: [],
    },
  });
});

it.each(['show', 'validate'])('refuses in workflows %s a name that leads out of the folder, exit 3', (verb) => {
  const { root, workflows } = workflowsSetup({});
  writeFileSync(join(root, 'x.json'), '{}');
  expect(workflows(verb, '../../x')).toEqual({
    code: 3,
    document: {
      result: null,
      findings: [],
      refusals: [{ code: 'workflow.name-invalid', params: { name: '../../x' } }],
    },
    stderr: '',
  });
});

it('refuses validate without --plugin-root when only cl-workflow@other is installed with plugin.untrusted, exit 3', () => {
  const { root } = project();
  // A plugin folder in the project, with a definition to run it on: only the trust rule keeps it from running.
  mkdirSync(join(root, 'definitions'));
  mkdirSync(join(root, 'generator'));
  writeFileSync(join(root, 'generator', 'generate.mjs'), GENERATOR);
  mkdirSync(join(root, '.cedarloom', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.cedarloom', 'workflows', 'mine.json'), '{}');
  const plugins = fresh();
  const record = {
    scope: 'user',
    installPath: root,
    version: '0.1.0',
    installedAt: '2026-11-01T00:00:00.000Z',
    lastUpdated: '2026-11-01T00:00:00.000Z',
    gitCommitSha: 'a'.repeat(40),
  };
  const installed = { version: 2, plugins: { 'cl-workflow@other': [record] } };
  writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify(installed));
  const env = { CEDARLOOM_STATE_DIR: fresh(), CLAUDE_CODE_PLUGIN_CACHE_DIR: plugins };
  expect(ran(['workflows', 'validate', '--json'], root, { env })).toEqual({
    code: 3,
    document: {
      result: null,
      findings: [],
      refusals: [{ code: 'plugin.untrusted', params: { id: 'cl-workflow@other' } }],
    },
    stderr: '',
  });
});

// 2,000 levels, past the depth at which a recursive JSON check overflows the stack.
const DEEP = `{"stages":${'['.repeat(2000)}${']'.repeat(2000)}}`;
const deepNotJson = { code: 'definition.not-json', params: { path: '.cedarloom/workflows/a-deep.json' } };

it('refuses with workflows show a definition nested too deep, or with a __proto__ member, as definition.not-json', () => {
  const { workflows } = workflowsSetup({ 'a-deep': DEEP, proto: '{"stages":[{"__proto__":{}}]}' });
  expect(workflows('show', 'a-deep')).toEqual({
    code: 3,
    document: { result: null, findings: [], refusals: [deepNotJson] },
    stderr: '',
  });
  expect(workflows('show', 'proto')).toMatchObject({
    code: 3,
    document: {
      refusals: [{ code: 'definition.not-json', params: { path: '.cedarloom/workflows/proto.json' } }],
    },
  });
});

it('answers a definition nested too deep with definition.not-json in workflows validate, next to a refused one', () => {
  const { workflows } = workflowsSetup({ 'a-deep': DEEP, bad: '{"refusals":["stages"]}' });
  expect(workflows('validate')).toMatchObject({
    code: 1,
    document: {
      result: {
        definitions: [
          { name: 'a-deep', source: 'project', generatorRefusals: [], refusals: [deepNotJson] },
          {
            name: 'bad',
            source: 'project',
            generatorRefusals: [{ file: '.cedarloom/workflows/bad.json', field: 'stages', rule: 'refused' }],
            refusals: [],
          },
        ],
      },
      refusals: [],
    },
  });
});

it('lists a definition nested too deep with the error finding definition.not-json, exit 1', () => {
  const { workflows } = workflowsSetup({ 'a-deep': DEEP });
  expect(workflows('list')).toMatchObject({
    code: 1,
    document: {
      result: { workflows: [{ name: 'dev' }, { name: 'a-deep', source: 'project', description: null }] },
      findings: [{ code: 'plugin.trust-bypassed' }, { code: 'plugin.found' }, { ...deepNotJson, severity: 'error' }],
      refusals: [],
    },
  });
});

it('answers with workflows show a name too long for a file with definition.not-found, exit 3', () => {
  const { workflows } = workflowsSetup({});
  const name = 'a'.repeat(300);
  expect(workflows('show', name)).toMatchObject({
    code: 3,
    document: { refusals: [{ code: 'definition.not-found', params: { name, source: 'project' } }] },
  });
});

describe('workflows generate', () => {
  const plan = {
    operations: [{ kind: 'create', path: '.claude/skills/mine/SKILL.md', before: null, after: 'Mine.\n' }],
    skipped: [],
  };

  it('shows the plan without --yes and applies nothing, exit 4; with --yes applies it as a run, exit 0', () => {
    const { root, workflows } = workflowsSetup({ mine: '{"writes":{"skills/mine/SKILL.md":"Mine.\\n"}}' });
    expect(workflows('generate', 'mine')).toMatchObject({
      code: 4,
      document: {
        result: { plan, applied: false, run: null, generatorRefusals: [] },
        refusals: [{ code: 'cli.confirm-required', params: {} }],
      },
    });
    expect(existsSync(join(root, '.claude', 'skills', 'mine'))).toBe(false);
    expect(workflows('generate', 'mine', '--yes')).toMatchObject({
      code: 0,
      document: { result: { plan, applied: true, run: 'u1', generatorRefusals: [] }, refusals: [] },
    });
  });

  it("reports the generator's refusals with no plan, exit 1", () => {
    const { workflows } = workflowsSetup({ bad: '{"refusals":["stages"]}' });
    expect(workflows('generate', '--yes')).toMatchObject({
      code: 1,
      document: {
        result: {
          plan: null,
          applied: false,
          run: null,
          generatorRefusals: [{ file: '.cedarloom/workflows/bad.json', field: 'stages', rule: 'refused' }],
        },
        refusals: [],
      },
    });
  });
});

it('plans with workflows new a copy of the shipped dev without --yes, exit 4, and applies it with --yes, exit 0', () => {
  const { workflows } = workflowsSetup({});
  const after =
    '{\n  "name": "mine",\n  "description": "Shipped dev.",\n  "stages": [\n    {\n      "id": "change",\n      "phases": []\n    }\n  ]\n}\n';
  const plan = { operations: [{ kind: 'create', path: '.cedarloom/workflows/mine.json', before: null, after }] };
  expect(workflows('new', 'mine')).toMatchObject({
    code: 4,
    document: { result: { plan, applied: false }, refusals: [{ code: 'cli.confirm-required', params: {} }] },
  });
  expect(workflows('new', 'mine', '--from', 'dev', '--yes')).toMatchObject({
    code: 0,
    document: { result: { plan, applied: true, run: 'u1' }, refusals: [] },
  });
});

it('switches with workflows off a workflow off in the settings after --yes, and workflows on switches it back on', () => {
  const { root, workflows } = workflowsSetup({ mine: '{"script":true}' });
  const env = { CEDARLOOM_STATE_DIR: fresh() };
  const settings = join(root, '.claude', 'settings.json');
  writeFileSync(settings, '{"model": "opus"}\n');
  const after = '{"model": "opus", "permissions": {"deny":["Skill(mine)", "Workflow(mine-run)"]}}\n';
  expect(ran(['workflows', 'off', 'mine', '--json'], root, { env })).toMatchObject({
    code: 4,
    document: { result: { plan: { operations: [{ kind: 'replace', after }] }, applied: false } },
  });
  expect(ran(['workflows', 'off', 'mine', '--yes', '--json'], root, { env })).toMatchObject({
    code: 0,
    document: { result: { applied: true, run: 'u1' }, refusals: [] },
  });
  expect(readFileSync(settings, 'utf8')).toBe(after);
  const clock = { now: () => new Date('2026-11-19T08:00:00.000Z'), newRunId: () => 'u2' };
  expect(ran(['workflows', 'on', 'mine', '--yes', '--json'], root, { env, clock })).toMatchObject({ code: 0 });
  expect(readFileSync(settings, 'utf8')).toBe('{"model": "opus", "permissions": {"deny":[]}}\n');
  expect(workflows('off', 'nope').document).toMatchObject({ refusals: [{ code: 'definition.not-found' }] });
});

it('plans with workflows set the edited definition without --yes, exit 4, and applies it with --yes, exit 0', () => {
  const { workflows } = workflowsSetup({ mine: '{"name":"mine"}' });
  const after = '{\n  "name": "mine",\n  "description": "Mine."\n}\n';
  const plan = {
    operations: [{ kind: 'replace', path: '.cedarloom/workflows/mine.json', before: '{"name":"mine"}', after }],
  };
  expect(workflows('set', 'mine', '/description', '"Mine."')).toMatchObject({
    code: 4,
    document: { result: { plan, applied: false }, refusals: [{ code: 'cli.confirm-required', params: {} }] },
  });
  expect(workflows('set', 'mine', '/description', '"Mine."', '--yes')).toMatchObject({
    code: 0,
    document: { result: { plan, applied: true, run: 'u1' }, refusals: [] },
  });
});
