import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { doctor } from './doctor.ts';

const folder = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'cedarloom-doctor-')));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

const json = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

const CEDARLOOM = { source: 'github', repo: 'CedarLoom/cedarloom', ref: 'stable' };

// A Git project, a plugins root and Claude Code's folder, whose user settings enable cl-workflow@cedarloom.
const setup = () => {
  const project = folder();
  mkdirSync(join(project, '.git'));
  const plugins = folder();
  const config = folder();
  json(join(config, 'settings.json'), { enabledPlugins: { 'cl-workflow@cedarloom': true } });
  json(join(plugins, 'known_marketplaces.json'), { cedarloom: { source: CEDARLOOM, installLocation: plugins } });
  // A version folder in the cache; a current one has the generator and the shipped definitions.
  const version = (marketplace: string, name: string, current = true): string => {
    const root = join(plugins, 'cache', marketplace, 'cl-workflow', name);
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    if (current) {
      mkdirSync(join(root, 'definitions'));
      mkdirSync(join(root, 'generator'));
      writeFileSync(join(root, 'generator', 'generate.mjs'), '');
    }
    return root;
  };
  const installed = (records: Record<string, unknown[]>): void =>
    json(join(plugins, 'installed_plugins.json'), { version: 2, plugins: records });
  const run = (pluginRoot: string | null = null, cwd = project) =>
    doctor({
      node: '26.13.0',
      required: '>=26',
      cwd,
      env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: plugins, CLAUDE_CONFIG_DIR: config },
      home: '',
      pluginRoot,
    });
  return { project, plugins, config, version, installed, run };
};

const record = (scope: string, installPath: string, extra: Record<string, unknown> = {}) => ({
  scope,
  installPath,
  version: installPath.split(/[\\/]/).at(-1),
  installedAt: '2026-11-01T00:00:00.000Z',
  lastUpdated: '2026-11-01T00:00:00.000Z',
  gitCommitSha: 'a'.repeat(40),
  ...extra,
});

const pluginFindings = (result: ReturnType<ReturnType<typeof setup>['run']>) =>
  result.findings.filter(({ code }) => code.startsWith('plugin.') || code.startsWith('settings.'));

it('takes the local-scope install over project scope and project over user, and reports it with plugin.found', () => {
  const { project, version, installed, run } = setup();
  const local = record('local', version('cedarloom', '0.3.0'), { projectPath: project });
  const shared = record('project', version('cedarloom', '0.2.0'), { projectPath: project });
  const user = record('user', version('cedarloom', '0.1.0'));
  const elsewhere = record('local', version('cedarloom', '0.4.0'), { projectPath: folder() });
  installed({ 'cl-workflow@cedarloom': [user, shared, local, elsewhere] });
  const root = local.installPath;
  expect(run()).toEqual({
    report: {
      checks: [
        { id: 'node', status: 'pass' },
        { id: 'project', status: 'pass' },
        { id: 'plugin', status: 'pass' },
      ],
      plugin: { id: 'cl-workflow@cedarloom', version: '0.3.0', scope: 'local', root },
    },
    findings: [
      {
        code: 'plugin.found',
        severity: 'info',
        params: { id: 'cl-workflow@cedarloom', version: '0.3.0', scope: 'local', root },
      },
    ],
  });
  installed({ 'cl-workflow@cedarloom': [user, shared, elsewhere] });
  expect(run().report.plugin).toMatchObject({ version: '0.2.0', scope: 'project' });
});

it('resolves the user scope only outside a repository, with project.not-found as a warning', () => {
  const { project, version, installed, run } = setup();
  const user = record('user', version('cedarloom', '0.1.0'));
  installed({
    'cl-workflow@cedarloom': [record('local', version('cedarloom', '0.2.0'), { projectPath: project }), user],
  });
  const outside = folder();
  const result = run(null, outside);
  expect(result.report.checks[1]).toEqual({ id: 'project', status: 'warn' });
  expect(result.findings[0]).toEqual({ code: 'project.not-found', severity: 'warning', params: { cwd: outside } });
  expect(result.report.plugin).toMatchObject({ version: '0.1.0', scope: 'user' });
});

it('refuses a cl-workflow from another marketplace with plugin.untrusted', () => {
  const { version, installed, run } = setup();
  installed({ 'cl-workflow@other': [record('user', version('other', '0.9.0'))] });
  const result = run();
  expect([result.report.checks[2], result.report.plugin, pluginFindings(result)]).toEqual([
    { id: 'plugin', status: 'fail' },
    null,
    [{ code: 'plugin.untrusted', severity: 'error', params: { id: 'cl-workflow@other' } }],
  ]);
});

it.each([
  [{ source: 'github', repo: 'Other/cedarloom' }, 'Other/cedarloom'],
  [
    { source: 'git', url: 'https://github.com/CedarLoom/cedarloom-fork.git' },
    'https://github.com/CedarLoom/cedarloom-fork.git',
  ],
  [
    { source: 'git', url: 'https://example.com/CedarLoom/cedarloom.git' },
    'https://example.com/CedarLoom/cedarloom.git',
  ],
  [{ source: 'directory', path: '/srv/cedarloom' }, '/srv/cedarloom'],
  [{ source: 'settings' }, 'settings'],
])('refuses a cedarloom marketplace from %j with plugin.marketplace-untrusted', (source, named) => {
  const { plugins, version, installed, run } = setup();
  installed({ 'cl-workflow@cedarloom': [record('user', version('cedarloom', '0.1.0'))] });
  json(join(plugins, 'known_marketplaces.json'), { cedarloom: { source } });
  expect(pluginFindings(run())).toEqual([
    {
      code: 'plugin.marketplace-untrusted',
      severity: 'error',
      params: { marketplace: 'cedarloom', source: named },
    },
  ]);
});

it.each([
  { source: 'github', repo: 'cedarloom/CedarLoom' },
  { source: 'git', url: 'https://github.com/CedarLoom/cedarloom.git' },
  { source: 'git', url: 'git@github.com:CedarLoom/cedarloom.git' },
])('trusts the cedarloom marketplace from %j', (source) => {
  const { plugins, version, installed, run } = setup();
  installed({ 'cl-workflow@cedarloom': [record('user', version('cedarloom', '0.1.0'))] });
  json(join(plugins, 'known_marketplaces.json'), { cedarloom: { source } });
  expect(run().report.checks[2]).toEqual({ id: 'plugin', status: 'pass' });
});

it('never uses an orphaned version folder, nor a folder no record names', () => {
  const { plugins, version, installed, run } = setup();
  const orphaned = version('cedarloom', '0.2.0');
  writeFileSync(join(orphaned, '.orphaned_at'), '1762000000000');
  version('cedarloom', '0.3.0');
  installed({ 'cl-workflow@cedarloom': [record('user', orphaned)] });
  expect(pluginFindings(run())).toEqual([
    { code: 'plugin.not-found', severity: 'error', params: { pluginsRoot: plugins } },
  ]);
});

it('reports plugin.not-found when no install record exists', () => {
  const { plugins, run } = setup();
  expect(pluginFindings(run())).toEqual([
    { code: 'plugin.not-found', severity: 'error', params: { pluginsRoot: plugins } },
  ]);
});

it.each([
  ['installed_plugins.json', { version: 3, plugins: {} }],
  ['installed_plugins.json', { version: 2, plugins: { 'cl-workflow@cedarloom': [{ scope: 'user' }] } }],
  [
    'installed_plugins.json',
    { version: 2, plugins: { 'cl-workflow@cedarloom': [{ scope: 'project', installPath: '/x' }] } },
  ],
  [
    'installed_plugins.json',
    { version: 2, plugins: { 'cl-workflow@cedarloom': [{ scope: 'user', installPath: 'cache/x' }] } },
  ],
  [
    'known_marketplaces.json',
    { cedarloom: { source: { source: 'github', url: 'https://github.com/CedarLoom/cedarloom' } } },
  ],
  ['known_marketplaces.json', { other: { source: CEDARLOOM } }],
])('reports plugin.record-unknown for %s holding %j', (name, content) => {
  const { plugins, version, installed, run } = setup();
  installed({ 'cl-workflow@cedarloom': [record('user', version('cedarloom', '0.1.0'))] });
  json(join(plugins, name), content);
  expect(pluginFindings(run())).toEqual([
    { code: 'plugin.record-unknown', severity: 'error', params: { file: join(plugins, name) } },
  ]);
});

it('reports plugin.too-old for a version folder without the generator', () => {
  const { version, installed, run } = setup();
  const root = version('cedarloom', '0.1.0', false);
  installed({ 'cl-workflow@cedarloom': [record('user', root)] });
  expect(pluginFindings(run())).toEqual([
    { code: 'plugin.too-old', severity: 'error', params: { root, version: '0.1.0' } },
  ]);
});

it('refuses a recorded install path that links to a folder elsewhere with plugin.untrusted', () => {
  const { plugins, version, installed, run } = setup();
  const elsewhere = version('other', '0.9.0');
  const linked = join(plugins, 'cache', 'cedarloom', 'cl-workflow', '0.1.0');
  mkdirSync(dirname(linked), { recursive: true });
  symlinkSync(elsewhere, linked, 'junction');
  installed({ 'cl-workflow@cedarloom': [record('user', linked)] });
  expect(pluginFindings(run())).toEqual([
    { code: 'plugin.untrusted', severity: 'error', params: { id: 'cl-workflow@cedarloom' } },
  ]);
});

it.skipIf(process.platform === 'win32')('refuses a generator that links outside the install path', () => {
  const { version, installed, run } = setup();
  const root = version('cedarloom', '0.1.0');
  const outside = join(folder(), 'generate.mjs');
  writeFileSync(outside, '');
  rmSync(join(root, 'generator', 'generate.mjs'));
  symlinkSync(outside, join(root, 'generator', 'generate.mjs'));
  installed({ 'cl-workflow@cedarloom': [record('user', root)] });
  expect(pluginFindings(run())).toEqual([
    { code: 'plugin.untrusted', severity: 'error', params: { id: 'cl-workflow@cedarloom' } },
  ]);
});

it('uses the folder relative to cwd and reports plugin.trust-bypassed', () => {
  const { project, run } = setup();
  const root = join(project, 'plugin');
  mkdirSync(join(root, 'definitions'), { recursive: true });
  mkdirSync(join(root, 'generator'));
  writeFileSync(join(root, 'generator', 'generate.mjs'), '');
  const plugin = { id: 'cl-workflow', version: null, scope: 'override', root };
  const result = run('plugin');
  expect([result.report.checks[2], result.report.plugin, pluginFindings(result)]).toEqual([
    { id: 'plugin', status: 'warn' },
    plugin,
    [
      { code: 'plugin.trust-bypassed', severity: 'warning', params: { root } },
      { code: 'plugin.found', severity: 'info', params: plugin },
    ],
  ]);
});

it('reports plugin.too-old with no version for a folder without the generator', () => {
  const { project, run } = setup();
  expect(pluginFindings(run(project))).toEqual([
    { code: 'plugin.trust-bypassed', severity: 'warning', params: { root: project } },
    { code: 'plugin.too-old', severity: 'error', params: { root: project, version: null } },
  ]);
});

const located = () => {
  const fixture = setup();
  fixture.installed({ 'cl-workflow@cedarloom': [record('user', fixture.version('cedarloom', '0.1.0'))] });
  return fixture;
};

it('reports plugin.disabled with the local settings when they switch off what the project settings enable', () => {
  const { project, run } = located();
  json(join(project, '.claude', 'settings.json'), { enabledPlugins: { 'cl-workflow@cedarloom': true } });
  json(join(project, '.claude', 'settings.local.json'), { enabledPlugins: { 'cl-workflow@cedarloom': false } });
  const result = run();
  expect([result.report.checks[2], pluginFindings(result).at(-1)]).toEqual([
    { id: 'plugin', status: 'warn' },
    {
      code: 'plugin.disabled',
      severity: 'warning',
      params: { path: join(project, '.claude', 'settings.local.json') },
    },
  ]);
});

it('reports plugin.disabled with no path when no settings file names the plugin', () => {
  const { config, run } = located();
  json(join(config, 'settings.json'), { enabledPlugins: { 'cl-workflow@other': true } });
  expect(pluginFindings(run()).at(-1)).toEqual({
    code: 'plugin.disabled',
    severity: 'warning',
    params: { path: null },
  });
});

it('reports settings.unreadable for project settings that are no JSON object', () => {
  const { project, run } = located();
  json(join(project, '.claude', 'settings.json'), []);
  const result = run();
  expect([result.report.checks[2], pluginFindings(result).at(-1)]).toEqual([
    { id: 'plugin', status: 'fail' },
    { code: 'settings.unreadable', severity: 'error', params: { path: join(project, '.claude', 'settings.json') } },
  ]);
});
