import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { definitionFindings } from './definition-checks.ts';

const folder = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'cedarloom-definitions-')));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// A generator in the plugin's form: refusals from the definition's "refusals", else the entry skill and, with
// "script", the workflow script, each with the generator's mark.
const GENERATOR = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [file, , , , , out] = process.argv.slice(2);
const def = JSON.parse(readFileSync(file, 'utf8'));
if (def.refusals) {
  console.log(JSON.stringify(def.refusals));
  process.exit(1);
}
const files = { ['skills/' + def.name + '/SKILL.md']: '<!-- Generated: edit the definition, not this file. -->\\n' + def.text + '\\n' };
if (def.script) files['workflows/' + def.name + '.js'] = '// Generated: edit the definition, not this file.\\n';
for (const [path, text] of Object.entries(files)) {
  mkdirSync(dirname(join(out, path)), { recursive: true });
  writeFileSync(join(out, path), text);
}
console.log('[]');
`;

const SKILL = '<!-- Generated: edit the definition, not this file. -->\nRun dev.\n';
const SCRIPT = '// Generated: edit the definition, not this file.\n';
const DEV = { name: 'dev', text: 'Run dev.', script: true };

// A project whose definition dev is in sync with its generated files, a plugin root with the generator, and a temp folder.
const setup = (generator = GENERATOR) => {
  const project = folder();
  const root = folder();
  const temp = folder();
  write(join(root, 'generator', 'generate.mjs'), generator);
  write(join(project, '.cedarloom', 'workflows', 'dev.json'), JSON.stringify(DEV));
  write(join(project, '.claude', 'skills', 'dev', 'SKILL.md'), SKILL);
  write(join(project, '.claude', 'workflows', 'dev.js'), SCRIPT);
  const check = (timeoutMs = 20_000) => definitionFindings({ project, root, temp, timeoutMs, env: process.env });
  return { project, temp, check };
};

const stale = (paths: string[]) => ({
  definitions: [],
  generated: [{ code: 'definition.stale', severity: 'warning', params: { name: 'dev', paths } }],
});
const notJson = (path: string) => ({
  definitions: [{ code: 'definition.not-json', severity: 'error', params: { path } }],
  generated: [],
});

// Every file below a folder with its text, links as their targets.
const tree = (path: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(path, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name), 'utf8')]),
  );

const isWindows = process.platform === 'win32';
const isRoot = process.getuid?.() === 0;

it('passes definitions whose generated files are in sync, keeping files without the mark out of the comparison', () => {
  const { project, check } = setup();
  write(join(project, '.claude', 'skills', 'dev', 'notes.md'), 'Own notes.\n');
  expect(check()).toEqual({ definitions: [], generated: [] });
});

it('passes a project without definitions', () => {
  const project = folder();
  const root = folder();
  expect(definitionFindings({ project, root, temp: folder(), timeoutMs: 20_000, env: {} })).toEqual({
    definitions: [],
    generated: [],
  });
});

describe('names each generated file that differs with definition.stale', () => {
  it('a changed file', () => {
    const { project, check } = setup();
    write(join(project, '.claude', 'skills', 'dev', 'SKILL.md'), `${SKILL}Edited.\n`);
    expect(check()).toEqual(stale(['.claude/skills/dev/SKILL.md']));
  });

  it('a missing file', () => {
    const { project, check } = setup();
    rmSync(join(project, '.claude', 'workflows', 'dev.js'));
    expect(check()).toEqual(stale(['.claude/workflows/dev.js']));
  });

  it('an extra file the generator no longer writes', () => {
    const { project, check } = setup();
    write(join(project, '.cedarloom', 'workflows', 'dev.json'), JSON.stringify({ ...DEV, script: false }));
    write(
      join(project, '.claude', 'skills', 'dev', 'agents', 'old.yaml'),
      '# Generated: edit the definition, not this file.\n',
    );
    expect(check()).toEqual(stale(['.claude/skills/dev/agents/old.yaml', '.claude/workflows/dev.js']));
  });

  it.skipIf(isWindows)('a file reached through a link', () => {
    const { project, check } = setup();
    const elsewhere = folder();
    write(join(elsewhere, 'SKILL.md'), SKILL);
    rmSync(join(project, '.claude', 'skills', 'dev'), { recursive: true });
    symlinkSync(elsewhere, join(project, '.claude', 'skills', 'dev'));
    expect(check()).toEqual(stale(['.claude/skills/dev/SKILL.md']));
  });
});

it('reports a definition the generator refuses with definition.invalid and the refusal count', () => {
  const { project, check } = setup();
  const refusals = [
    { file: 'x', field: '/name', rule: 'kebab-case' },
    { file: 'x', field: '/stages', rule: 'a non-empty array' },
  ];
  write(join(project, '.cedarloom', 'workflows', 'dev.json'), JSON.stringify({ refusals }));
  expect(check()).toEqual({
    definitions: [{ code: 'definition.invalid', severity: 'error', params: { name: 'dev', count: 2 } }],
    generated: [],
  });
});

describe('reports each definition it cannot use with its finding', () => {
  it('definition.not-json for a file that is not JSON', () => {
    const { project, check } = setup();
    write(join(project, '.cedarloom', 'workflows', 'dev.json'), '{"name": ');
    expect(check()).toEqual(notJson('.cedarloom/workflows/dev.json'));
  });

  it('definition.not-json for a folder', () => {
    const { project, check } = setup();
    mkdirSync(join(project, '.cedarloom', 'workflows', 'more.json'));
    expect(check().definitions).toEqual(notJson('.cedarloom/workflows/more.json').definitions);
  });

  it('definition.not-json for a definitions folder that is a file', () => {
    const { project, check } = setup();
    rmSync(join(project, '.cedarloom', 'workflows'), { recursive: true });
    write(join(project, '.cedarloom', 'workflows'), '');
    // ENOTDIR on Linux and macOS, ENOENT on Windows, which reads it as no definitions.
    expect(check()).toEqual(isWindows ? { definitions: [], generated: [] } : notJson('.cedarloom/workflows'));
  });

  it.skipIf(isWindows)('definition.not-json for a link, also one that loops', () => {
    const { project, check } = setup();
    const workflows = join(project, '.cedarloom', 'workflows');
    symlinkSync(join(workflows, 'dev.json'), join(workflows, 'copy.json'));
    symlinkSync(join(workflows, 'loop.json'), join(workflows, 'loop.json'));
    expect(check().definitions).toEqual([
      ...notJson('.cedarloom/workflows/copy.json').definitions,
      ...notJson('.cedarloom/workflows/loop.json').definitions,
    ]);
  });

  it.skipIf(isWindows)('definition.not-json for a FIFO, without waiting on it', () => {
    const { project, check } = setup();
    execFileSync('mkfifo', [join(project, '.cedarloom', 'workflows', 'pipe.json')]);
    expect(check().definitions).toEqual(notJson('.cedarloom/workflows/pipe.json').definitions);
  });

  it.skipIf(isWindows || isRoot)('definition.not-json for a file or folder the app may not read', () => {
    const { project, check } = setup();
    const workflows = join(project, '.cedarloom', 'workflows');
    chmodSync(join(workflows, 'dev.json'), 0o000);
    expect(check().definitions).toEqual(notJson('.cedarloom/workflows/dev.json').definitions);
    chmodSync(workflows, 0o000);
    onTestFinished(() => chmodSync(workflows, 0o700));
    expect(check()).toEqual(notJson('.cedarloom/workflows'));
  });
});

describe('reports a generator it cannot use with its finding', () => {
  it('generator.failed with the exit code and the error output', () => {
    const { check } = setup("process.stderr.write('broken');\nprocess.exit(3);\n");
    expect(check().definitions).toEqual([
      { code: 'generator.failed', severity: 'error', params: { exitCode: 3, signal: null, stderr: 'broken' } },
    ]);
  });

  it('generator.failed with SIGKILL for a generator that does not end in time', () => {
    const { check } = setup('setInterval(() => {}, 1000);\n');
    expect(check(500).definitions).toEqual([
      { code: 'generator.failed', severity: 'error', params: { exitCode: null, signal: 'SIGKILL', stderr: '' } },
    ]);
  });

  it('generator.output-unknown for output that is no refusal list', () => {
    const { check } = setup("console.log('done');\n");
    expect(check().definitions).toEqual([
      { code: 'generator.output-unknown', severity: 'error', params: { output: 'done\n' } },
    ]);
  });
});

it('removes its temporary folder and writes nothing into the project', () => {
  const { project, temp, check } = setup();
  write(join(project, '.claude', 'skills', 'dev', 'SKILL.md'), 'Edited.\n');
  const before = tree(project);
  expect(check().generated).toHaveLength(1);
  expect([tree(project), readdirSync(temp)]).toEqual([before, []]);
});
