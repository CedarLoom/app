import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ApplyRequest, apply } from './apply.ts';
import { failAt, fresh, project, store, text } from './test-fixtures.ts';
import { undo } from './undo.ts';
import { workflowsOff, workflowsOn } from './workflow-switch.ts';

const SETTINGS = '.claude/settings.json';
const POINTER = '/enabledPlugins/cl-workflow@cedarloom';
const OWNER = `{
  "model": "opus",
  "permissions": {
    "allow": ["Bash(ls)"],
    "deny": ["Read(.env)"]
  },
  "enabledPlugins": {"other@market": true}
}
`;
const ownerEntry = (key: string, kept = true) => ({
  code: 'settings.owner-entry',
  severity: 'warning',
  params: { path: SETTINGS, key, kept },
});

// A project with the settings given and the definitions dev (with a script) and plain (without), a plugin root that
// ships full (with a script), and a held store that names its runs r1, r2, and so on.
const setup = (settings?: string) => {
  const { root, state } = project(settings === undefined ? {} : { [SETTINGS]: settings });
  mkdirSync(join(root, '.cedarloom', 'workflows'), { recursive: true });
  for (const [name, script] of [
    ['dev', true],
    ['plain', false],
  ] as const)
    writeFileSync(join(root, '.cedarloom', 'workflows', `${name}.json`), JSON.stringify({ name, script }));
  const plugin = realpathSync(fresh());
  mkdirSync(join(plugin, 'generator'));
  writeFileSync(join(plugin, 'generator', 'generate.mjs'), '');
  mkdirSync(join(plugin, 'definitions'));
  writeFileSync(join(plugin, 'definitions', 'full.json'), JSON.stringify({ name: 'full', script: true }));
  const held = store(state, ...Array.from({ length: 9 }, (_, index) => `r${index + 1}`));
  const base = { root, cwd: root, env: {}, home: fresh(), pluginRoot: plugin };
  const off = (id: string | null, { yes = true, scriptOnly = false } = {}) =>
    workflowsOff(held, { ...base, id, scriptOnly }, yes);
  const on = (id: string | null, yes = true) => workflowsOn(held, { root, id }, yes);
  const read = () => text(join(root, SETTINGS));
  const edit = (value: string) => writeFileSync(join(root, SETTINGS), value);
  const entries = (id: string) => held.run(id)?.operations.map((operation) => operation.entries);
  return { root, held, off, on, read, edit, entries };
};

const withDeny = (rules: string) => OWNER.replace('["Read(.env)"]', rules);

describe('workflows off for a workflow', () => {
  it('appends the rules to owner settings byte for byte as a run with its entries, and undo restores the file', () => {
    const { root, held, off, read, entries } = setup(OWNER);
    expect(off('dev')).toMatchObject({ run: 'r1', refusals: [], plan: { skipped: [] } });
    expect(read()).toBe(withDeny('["Read(.env)", "Skill(dev)", "Workflow(dev-run)"]'));
    expect(entries('r1')).toEqual([
      [
        { pointer: '/permissions/deny', value: 'Skill(dev)' },
        { pointer: '/permissions/deny', value: 'Workflow(dev-run)' },
      ],
    ]);
    expect(undo(held, { root, run: 'r1' }).refusal).toBeNull();
    expect(read()).toBe(OWNER);
  });

  it('creates a missing settings file, and writes nothing without --yes', () => {
    const { off, read } = setup();
    expect(off('dev', { yes: false })).toMatchObject({ run: null, plan: { operations: [{ kind: 'create' }] } });
    expect(read()).toBeNull();
    off('dev');
    expect(JSON.parse(read() ?? '')).toEqual({ permissions: { deny: ['Skill(dev)', 'Workflow(dev-run)'] } });
  });

  it('on removes exactly its own rules after the owner inserted one in front of them', () => {
    const { off, on, read, edit, entries } = setup(OWNER);
    off('dev');
    edit(withDeny('["Read(.env)", "Bash(rm)", "Skill(dev)", "Workflow(dev-run)"]'));
    expect(on('dev')).toMatchObject({ run: 'r2', plan: { skipped: [] } });
    expect(read()).toBe(withDeny('["Read(.env)", "Bash(rm)"]'));
    expect(entries('r2')).toEqual([
      [
        { pointer: '/permissions/deny', value: 'Skill(dev)' },
        { pointer: '/permissions/deny', value: 'Workflow(dev-run)' },
      ],
    ]);
    expect(on('dev')).toMatchObject({ run: null, plan: { operations: [], skipped: [] } });
  });
});

describe('workflows on for a workflow', () => {
  it('on leaves and reports a recorded rule the owner removed', () => {
    const { off, on, read, edit } = setup(OWNER);
    off('dev');
    edit(OWNER);
    expect(on('dev')).toMatchObject({
      run: null,
      plan: { operations: [], skipped: [ownerEntry('Skill(dev)'), ownerEntry('Workflow(dev-run)')] },
    });
    expect(read()).toBe(OWNER);
  });

  it('leaves and reports an owner rule equal to its own that was there before off', () => {
    const owned = withDeny('["Skill(dev)"]');
    const { off, on, read } = setup(owned);
    expect(off('dev').plan?.skipped).toEqual([ownerEntry('Skill(dev)')]);
    expect(read()).toBe(withDeny('["Skill(dev)", "Workflow(dev-run)"]'));
    expect(on('dev').plan?.skipped).toEqual([ownerEntry('Skill(dev)')]);
    expect(read()).toBe(owned);
  });

  it('denies only the skill of a definition with script false, and only the workflow with --script-only', () => {
    const { off, read } = setup(OWNER);
    off('plain');
    off('dev', { scriptOnly: true });
    expect(read()).toBe(withDeny('["Read(.env)", "Skill(plain)", "Workflow(dev-run)"]'));
    expect(off('plain', { scriptOnly: true })).toMatchObject({
      plan: null,
      refusals: [{ code: 'workflow.no-script', params: { name: 'plain' } }],
    });
  });

  it('reads a shipped definition from the plugin and names the rules with its prefix', () => {
    const { off, on, read } = setup('{}\n');
    off('cl-workflow:full');
    expect(read()).toBe('{"permissions": {"deny":["Skill(cl-workflow:full)", "Workflow(cl-workflow:full-run)"]}}\n');
    on('cl-workflow:full');
    expect(read()).toBe('{"permissions": {"deny":[]}}\n');
  });
});

// The owner writes Skill(dev) by hand; on leaves it and reports it.
const ownerRuleStays = ({ on, read, edit }: ReturnType<typeof setup>): void => {
  const owned = withDeny('["Read(.env)", "Skill(dev)"]');
  edit(owned);
  expect(on('dev')).toMatchObject({ run: null, plan: { operations: [], skipped: [ownerEntry('Skill(dev)')] } });
  expect(read()).toBe(owned);
};

describe('workflows on after an off run that is not in effect', () => {
  it('on leaves and reports a rule the owner wrote after the off run was undone', () => {
    const context = setup(OWNER);
    context.off('dev');
    expect(undo(context.held, { root: context.root, run: 'r1' }).refusal).toBeNull();
    ownerRuleStays(context);
  });

  it('an off run stopped before its write owns nothing', () => {
    const context = setup(OWNER);
    const { root, held, off } = context;
    const { plan } = off('dev', { yes: false });
    if (plan === null) throw new Error('no plan');
    const run = {
      kind: 'apply',
      action: 'workflow.off',
      subject: 'dev',
      undoes: null,
      generatedFrom: [],
    } satisfies ApplyRequest['run'];
    const written = [
      { pointer: '/permissions/deny', value: 'Skill(dev)' },
      { pointer: '/permissions/deny', value: 'Workflow(dev-run)' },
    ];
    expect(() => apply(held, { root, plan, run, entries: new Map([[0, written]]) }, failAt('temp-written', 0))).toThrow(
      'disk gone',
    );
    ownerRuleStays(context);
  });
});

const plugins = (value?: boolean) =>
  `{"enabledPlugins": {"other@market": true${value === undefined ? '' : `, "cl-workflow@cedarloom": ${value}`}}}\n`;

describe('workflows off and on for the plugin', () => {
  it('off writes an absent entry, leaves it once it is its own, and on removes it', () => {
    const { off, on, read, entries } = setup(plugins());
    off(null);
    expect([read(), entries('r1')]).toEqual([plugins(false), [[{ pointer: POINTER, value: false }]]]);
    expect(off(null)).toMatchObject({ run: null, plan: { operations: [], skipped: [] } });
    on(null);
    expect([read(), entries('r2')]).toEqual([plugins(), [[{ pointer: POINTER, value: false }]]]);
  });

  it('off and on leave and report an owner false', () => {
    const { off, on, read } = setup(plugins(false));
    expect(off(null)).toMatchObject({ run: null, plan: { operations: [], skipped: [ownerEntry(POINTER)] } });
    expect(on(null)).toMatchObject({ run: null, plan: { operations: [], skipped: [ownerEntry(POINTER)] } });
    expect(read()).toBe(plugins(false));
  });

  it('off changes an owner true to false with a warning, on writes the true back, and undo restores it', () => {
    const { root, held, off, on, read, entries } = setup(plugins(true));
    expect(off(null, { yes: false })).toMatchObject({ run: null, plan: { skipped: [ownerEntry(POINTER, false)] } });
    expect(read()).toBe(plugins(true));
    off(null);
    expect([read(), entries('r1')]).toEqual([plugins(false), [[{ pointer: POINTER, value: false, before: true }]]]);
    on(null);
    expect([read(), entries('r2')]).toEqual([plugins(true), [[{ pointer: POINTER, value: true, before: false }]]]);
    off(null);
    expect(undo(held, { root, run: 'r3' }).refusal).toBeNull();
    expect(read()).toBe(plugins(true));
  });
});

describe('a settings file workflows off and on do not change', () => {
  it.each([
    ['is not JSON', Buffer.from('{"permissions": {"deny": [],}}')],
    ['has a deny that is not an array', Buffer.from('{"permissions": {"deny": "Skill(dev)"}}')],
    ['is not UTF-8', Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])],
    ['nests deeper than 100', Buffer.from(`{"a": ${'['.repeat(100)}${']'.repeat(100)}}`)],
  ])('refuses one that %s with settings.unreadable and writes nothing', (_, settings) => {
    const { root, off, on } = setup();
    writeFileSync(join(root, SETTINGS), settings);
    for (const result of [off('dev'), on('dev'), off(null)])
      expect(result).toMatchObject({
        plan: null,
        run: null,
        refusals: [{ code: 'settings.unreadable', params: { path: SETTINGS } }],
      });
    expect(readFileSync(join(root, SETTINGS))).toEqual(settings);
  });

  it.each(['cl-workflow:', 'cl-workflow:cl-workflow:a'])(
    'refuses the id %s with workflow.name-invalid as typed',
    (id) => {
      const { off, on, read } = setup(OWNER);
      for (const result of [off(id), on(id)])
        expect(result).toMatchObject({
          plan: null,
          refusals: [{ code: 'workflow.name-invalid', params: { name: id } }],
        });
      expect(read()).toBe(OWNER);
    },
  );

  it.skipIf(process.platform === 'win32')('refuses a settings file that is a link with plan.symlink', () => {
    const { root, off } = setup();
    const outside = join(fresh(), 'settings.json');
    writeFileSync(outside, '{}');
    symlinkSync(outside, join(root, SETTINGS));
    expect(off('dev').refusals).toEqual([{ code: 'plan.symlink', params: { path: SETTINGS } }]);
    expect(text(outside)).toBe('{}');
  });
});
