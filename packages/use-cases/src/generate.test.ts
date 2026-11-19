import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { apply } from './apply.ts';
import { type GenerateRequest, generateWorkflows, planGeneration } from './generate.ts';
import { openStore } from './store.ts';
import { undo } from './undo.ts';

const folder = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'cedarloom-generation-')));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// A stub generator with hardcoded outputs: each definition's "skill" as its SKILL.md, a fixed script while "script" is
// set, and each path of "extra" with fixed text.
const STUB = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const argv = process.argv.slice(2);
const into = argv[argv.indexOf('--out') + 1];
const emit = (path, text) => {
  mkdirSync(dirname(join(into, path)), { recursive: true });
  writeFileSync(join(into, path), text);
};
for (const definition of argv.slice(0, argv.indexOf('--json'))) {
  const { name, skill, script, extra = [] } = JSON.parse(readFileSync(definition, 'utf8'));
  emit('skills/' + name + '/SKILL.md', skill);
  if (script) emit('workflows/' + name + '.js', 'export default "stub";\\n');
  for (const path of extra) emit(path, 'extra\\n');
}
process.stdout.write('[]');
`;

const SKILL = '.claude/skills/dev/SKILL.md';
const SCRIPT = '.claude/workflows/dev.js';
const STUB_SCRIPT = 'export default "stub";\n';

// A project with the definition dev, a plugin root with the stub generator, and a held store.
const setup = (definition: object) => {
  const project = folder();
  const plugin = folder();
  put(join(plugin, 'generator', 'generate.mjs'), STUB);
  mkdirSync(join(plugin, 'definitions'));
  const define = (value: object) => put(join(project, '.cedarloom', 'workflows', 'dev.json'), JSON.stringify(value));
  define(definition);
  const opened = openStore(folder(), { now: () => new Date('2026-11-20T08:00:00.000Z'), newRunId: randomUUID });
  if (!opened.ok) throw new Error(opened.refusal.code);
  const store = opened.value;
  onTestFinished(() => store.close());
  const request: GenerateRequest = {
    root: project,
    cwd: project,
    env: {},
    home: folder(),
    pluginRoot: plugin,
    names: [],
  };
  const generated = (yes = true) => generateWorkflows(store, request, yes);
  const text = (path: string) => readFileSync(join(project, path), 'utf8');
  const edit = (path: string, value: string) => writeFileSync(join(project, path), value);
  return { project, store, request, define, generated, text, edit };
};

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

const kinds = (plan: { operations: { kind: string; path: string }[] } | null) =>
  plan?.operations.map(({ kind, path }) => [kind, path]);

it('workflows generate creates the outputs in path order as a run that records the definition, then plans nothing', () => {
  const { store, generated, text } = setup({ name: 'dev', skill: 'Run dev.\n', script: true });
  const first = generated();
  expect(kinds(first.plan)).toEqual([
    ['create', SKILL],
    ['create', SCRIPT],
  ]);
  expect(first.refusals).toEqual([]);
  expect([text(SKILL), text(SCRIPT)]).toEqual(['Run dev.\n', STUB_SCRIPT]);
  expect(store.run(first.run ?? '')).toMatchObject({
    kind: 'apply',
    action: 'workflow.generate',
    subject: 'dev',
    status: 'done',
    generatedFrom: [{ name: 'dev', definition: '{"name":"dev","skill":"Run dev.\\n","script":true}' }],
  });
  const again = generated();
  expect([again.plan?.operations, again.run]).toEqual([[], null]);
});

it("plans a replace from the owner's edit inside a generated file, and undo brings the edit back", () => {
  const { store, request, generated, text, edit } = setup({ name: 'dev', skill: 'Run dev.\n' });
  generated();
  edit(SKILL, 'Run dev, my way.\n');
  const replaced = generated();
  expect(replaced.plan?.operations).toMatchObject([
    { kind: 'replace', path: SKILL, before: 'Run dev, my way.\n', after: 'Run dev.\n' },
  ]);
  expect(text(SKILL)).toBe('Run dev.\n');
  expect(undo(store, { root: request.root, run: replaced.run ?? '' }).refusal).toBeNull();
  expect(text(SKILL)).toBe('Run dev, my way.\n');
});

it('refuses with plan.file-changed when the owner edits a file between plan and apply', () => {
  const { store, request, define, generated, edit, text } = setup({ name: 'dev', skill: 'Run dev.\n' });
  generated();
  define({ name: 'dev', skill: 'Run dev twice.\n' });
  const { plan, generatedFrom } = planGeneration(store, request);
  edit(SKILL, 'Mine.\n');
  const run = { kind: 'apply', action: 'workflow.generate', subject: 'dev', undoes: null, generatedFrom } as const;
  expect(
    apply(store, { root: request.root, plan: plan ?? { planHash: '', operations: [], skipped: [] }, run }),
  ).toEqual({
    run: null,
    refusal: { code: 'plan.file-changed', params: { path: SKILL } },
    findings: [],
  });
  expect(text(SKILL)).toBe('Mine.\n');
});

it('deletes the script once script is set from true to false, and undo restores it', () => {
  const { store, request, define, generated, project, text } = setup({
    name: 'dev',
    skill: 'Run dev.\n',
    script: true,
  });
  generated();
  define({ name: 'dev', skill: 'Run dev.\n', script: false });
  const deleted = generated();
  expect(kinds(deleted.plan)).toEqual([['delete', SCRIPT]]);
  expect(existsSync(join(project, SCRIPT))).toBe(false);
  expect(undo(store, { root: request.root, run: deleted.run ?? '' }).refusal).toBeNull();
  expect(text(SCRIPT)).toBe(STUB_SCRIPT);
});

it('deletes the files of a removed definition as its newest generation left them', () => {
  const { define, generated, project } = setup({ name: 'dev', skill: 'Run dev.\n', script: true });
  generated();
  define({ name: 'dev', skill: 'Run dev twice.\n', script: true });
  generated();
  rmSync(join(project, '.cedarloom', 'workflows', 'dev.json'));
  expect(kinds(generated().plan)).toEqual([
    ['delete', SKILL],
    ['delete', SCRIPT],
  ]);
});

it("deletes what a failed generation's done steps wrote, judged by its done steps alone", () => {
  const { store, define, generated, project } = setup({ name: 'dev', skill: 'Run dev.\n', script: true });
  generated();
  const notes = '.claude/skills/dev/notes.md';
  put(join(project, notes), 'notes\n');
  const begun = store.begin({
    kind: 'apply',
    action: 'workflow.generate',
    subject: 'dev',
    undoes: null,
    planHash: hash('plan'),
    generatedFrom: [{ name: 'dev', definition: '{}' }],
    operations: [
      { kind: 'create', path: notes, beforeHash: null, afterHash: hash('notes\n'), entries: null },
      { kind: 'replace', path: SCRIPT, beforeHash: hash(STUB_SCRIPT), afterHash: hash('other\n'), entries: null },
    ],
  });
  if (!begun.ok) throw new Error(begun.refusal.code);
  store.settle(begun.value, 0, 'done');
  store.finish(begun.value, 'failed');
  define({ name: 'dev', skill: 'Run dev.\n', script: false });
  expect(kinds(generated().plan)).toEqual([
    ['delete', notes],
    ['delete', SCRIPT],
  ]);
});

it('keeps a file no longer generated that the owner changed, and reports it as skipped', () => {
  const { define, generated, edit, text } = setup({ name: 'dev', skill: 'Run dev.\n', script: true });
  generated();
  edit(SCRIPT, 'export default "mine";\n');
  define({ name: 'dev', skill: 'Run dev.\n', script: false });
  expect(generated().plan).toMatchObject({
    operations: [],
    skipped: [{ code: 'generate.delete-skipped', severity: 'warning', params: { path: SCRIPT } }],
  });
  expect(text(SCRIPT)).toBe('export default "mine";\n');
});

it('refuses an output path outside the write roots with plan.path-outside-roots', () => {
  const { generated, project } = setup({ name: 'dev', skill: 'Run dev.\n', extra: ['skills/dev/.git/config'] });
  expect(generated()).toMatchObject({
    plan: null,
    run: null,
    refusals: [{ code: 'plan.path-outside-roots', params: { path: '.claude/skills/dev/.git/config' } }],
  });
  expect(existsSync(join(project, SKILL))).toBe(false);
});

it.skipIf(process.platform === 'win32')('refuses a planned path through a link with plan.symlink', () => {
  const { generated, project } = setup({ name: 'dev', skill: 'Run dev.\n' });
  const outside = folder();
  mkdirSync(join(project, '.claude'));
  symlinkSync(outside, join(project, '.claude', 'skills'));
  expect(generated()).toMatchObject({
    plan: null,
    refusals: [{ code: 'plan.symlink', params: { path: '.claude/skills' } }],
  });
  expect(existsSync(join(outside, 'dev'))).toBe(false);
});
