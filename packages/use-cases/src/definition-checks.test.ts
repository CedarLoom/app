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
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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

// A generator in the plugin's form: for each definition a refusal per entry of its "refusals", else the entry skill
// and, with "script", the workflow script, each with the generator's header.
const GENERATOR = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
const out = args.at(-1);
const refusals = [];
const outputs = {};
for (const file of args.slice(0, args.indexOf('--json'))) {
  const def = JSON.parse(readFileSync(file, 'utf8'));
  for (const field of def.refusals ?? []) refusals.push({ file, field, rule: 'refused' });
  const header = 'Generated from .cedarloom/workflows/' + def.name + ".json by cl-workflow's generator/generate.mjs: edit the definition, not this file.";
  outputs['skills/' + def.name + '/SKILL.md'] = '<!-- ' + header + ' -->\\n' + def.text + '\\n';
  if (def.script) outputs['workflows/' + def.name + '.js'] = '// ' + header + '\\n';
}
console.log(JSON.stringify(refusals));
// As the plugin's generator does: process.exit could end the process before a long refusal list is written.
process.exitCode = refusals.length ? 1 : 0;
if (!refusals.length) {
  for (const [path, text] of Object.entries(outputs)) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), text);
  }
}
`;

const HEADER =
  "Generated from .cedarloom/workflows/dev.json by cl-workflow's generator/generate.mjs: edit the definition, not this file.";
const SKILL = `<!-- ${HEADER} -->\nRun dev.\n`;
const SCRIPT = `// ${HEADER}\n`;
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
  const check = (timeoutMs = 20_000, env: NodeJS.ProcessEnv = process.env) =>
    definitionFindings({ project, root, temp, timeoutMs, env });
  return { project, root, temp, check };
};

const staleFinding = (name: string, paths: string[]) => ({
  code: 'definition.stale',
  severity: 'warning',
  params: { name, paths },
});
const stale = (paths: string[]) => ({ definitions: [], generated: [staleFinding('dev', paths)] });
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

// A file of 2 GiB, more than Node.js reads into one buffer; sparse where the file system allows it.
const large = (path: string): void => {
  write(path, '');
  truncateSync(path, 2 ** 31);
};

const isWindows = process.platform === 'win32';
const isRoot = process.getuid?.() === 0;

// A link at path; the test is skipped where the platform refuses to make one, as Windows does without the privilege.
const link = (target: string, path: string, skip: (note: string) => never): void => {
  try {
    symlinkSync(target, path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') skip('this account cannot make links');
    throw error;
  }
};

it('passes definitions whose generated files are in sync, keeping files without the mark out of the comparison', () => {
  const { project, check } = setup();
  write(join(project, '.claude', 'skills', 'dev', 'notes.md'), 'Own notes.\n');
  expect(check()).toEqual({ definitions: [], generated: [] });
});

it('passes a large file below a skill folder, reading only its head for the mark', () => {
  const { project, check } = setup();
  large(join(project, '.claude', 'skills', 'own', 'assets', 'large.bin'));
  expect(check()).toEqual({ definitions: [], generated: [] });
});

it('names a generated file too large to read whole with definition.stale', () => {
  const { project, check } = setup();
  large(join(project, '.claude', 'skills', 'dev', 'SKILL.md'));
  expect(check()).toEqual(stale(['.claude/skills/dev/SKILL.md']));
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

  it.skipIf(isWindows || isRoot)('an extra file beside a link in the skill folder, which is not followed', () => {
    const { project, check } = setup();
    const elsewhere = folder();
    mkdirSync(join(elsewhere, 'locked'));
    chmodSync(join(elsewhere, 'locked'), 0o000);
    onTestFinished(() => chmodSync(join(elsewhere, 'locked'), 0o700));
    symlinkSync(elsewhere, join(project, '.claude', 'skills', 'dev', 'elsewhere'));
    write(
      join(project, '.claude', 'skills', 'dev', 'old.md'),
      '<!-- Generated: edit the definition, not this file. -->\n',
    );
    expect(check()).toEqual(stale(['.claude/skills/dev/old.md']));
  });

  it('a file in another skill folder whose header names the definition', () => {
    const { project, check } = setup();
    write(join(project, '.claude', 'skills', 'dev2', 'SKILL.md'), SKILL);
    expect(check()).toEqual(stale(['.claude/skills/dev2/SKILL.md']));
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

describe('names the generated files of a definition that is gone with definition.stale', () => {
  it('removed, also when none is left', () => {
    const { project, check } = setup();
    rmSync(join(project, '.cedarloom', 'workflows', 'dev.json'));
    expect(check()).toEqual(stale(['.claude/skills/dev/SKILL.md', '.claude/workflows/dev.js']));
  });

  it('renamed, by the name their header gives', () => {
    const { project, check } = setup();
    write(join(project, '.cedarloom', 'workflows', 'dev.json'), JSON.stringify({ ...DEV, name: 'study' }));
    expect(check()).toEqual({
      definitions: [],
      generated: [
        staleFinding('study', ['.claude/skills/study/SKILL.md', '.claude/workflows/study.js']),
        staleFinding('dev', ['.claude/skills/dev/SKILL.md', '.claude/workflows/dev.js']),
      ],
    });
  });

  it.skipIf(isWindows || isRoot)('beside a folder the app may not read', () => {
    const { project, check } = setup();
    rmSync(join(project, '.cedarloom', 'workflows', 'dev.json'));
    const locked = join(project, '.claude', 'skills', 'dev', 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    onTestFinished(() => chmodSync(locked, 0o700));
    expect(check()).toEqual(stale(['.claude/skills/dev/SKILL.md', '.claude/workflows/dev.js']));
  });
});

it('leaves the generated files of other definitions alone while a definition file cannot be read', () => {
  const { project, check } = setup();
  write(join(project, '.cedarloom', 'workflows', 'research.json'), '{"name": ');
  write(join(project, '.claude', 'skills', 'research', 'SKILL.md'), SKILL.replace('dev.json', 'research.json'));
  expect(check()).toEqual(notJson('.cedarloom/workflows/research.json'));
});

it('reports each definition the generator refuses with definition.invalid, its file and its refusal count', () => {
  const { project, check } = setup();
  const workflows = join(project, '.cedarloom', 'workflows');
  write(join(workflows, 'dev.json'), JSON.stringify({ ...DEV, name: 'study', refusals: ['/name', '/stages'] }));
  write(join(workflows, 'other.json'), JSON.stringify({ name: 'other', text: 'Run other.' }));
  expect(check()).toEqual({
    definitions: [
      { code: 'definition.invalid', severity: 'error', params: { path: '.cedarloom/workflows/dev.json', count: 2 } },
    ],
    generated: [],
  });
});

it('reports a refusal list longer than 1 MiB with definition.invalid', () => {
  const { project, check } = setup();
  const refusals = Array.from({ length: 20_000 }, (_, index) => `/field-${String(index).padStart(60, '0')}`);
  write(join(project, '.cedarloom', 'workflows', 'dev.json'), JSON.stringify({ ...DEV, refusals }));
  expect(check().definitions).toEqual([
    { code: 'definition.invalid', severity: 'error', params: { path: '.cedarloom/workflows/dev.json', count: 20_000 } },
  ]);
});

it('reads generated files checked out with CRLF line endings as in sync', () => {
  const { project, check } = setup();
  write(join(project, '.claude', 'skills', 'dev', 'SKILL.md'), SKILL.replaceAll('\n', '\r\n'));
  expect(check()).toEqual({ definitions: [], generated: [] });
});

it('reads generated files as in sync where the generator writes CRLF, as it copies a runner checked out with CRLF', () => {
  const { project, check } = setup(
    GENERATOR.replace("'// ' + header + '\\n'", "'// ' + header + '\\r\\nrun();\\r\\n'"),
  );
  write(join(project, '.claude', 'workflows', 'dev.js'), `// ${HEADER}\r\nrun();\r\n`);
  expect(check()).toEqual({ definitions: [], generated: [] });
});

it('matches outputs to their definition by the header line alone', () => {
  const { project, check } = setup();
  const RESEARCH = { name: 'research', text: 'See .cedarloom/workflows/dev.json by hand.' };
  write(join(project, '.cedarloom', 'workflows', 'research.json'), JSON.stringify(RESEARCH));
  write(
    join(project, '.claude', 'skills', 'research', 'SKILL.md'),
    `<!-- ${HEADER.replace('dev.json', 'research.json')} -->\n${RESEARCH.text}\n`,
  );
  expect(check()).toEqual({ definitions: [], generated: [] });
});

describe('runs the generator apart from the caller', () => {
  it('with no variable of the caller environment but SystemRoot', () => {
    const { check } = setup(`if ('CEDARLOOM_TEST_MARKER' in process.env) process.exit(3);\n${GENERATOR}`);
    expect(check(20_000, { ...process.env, CEDARLOOM_TEST_MARKER: '1' })).toEqual({ definitions: [], generated: [] });
  });

  it('in its temporary folder, where a relative path leads', () => {
    const { check } = setup(GENERATOR.replace('const out = args.at(-1);', "const out = 'out';"));
    expect(check()).toEqual({ definitions: [], generated: [] });
  });

  it('with a relative temporary folder, giving the generator absolute paths', () => {
    const { project, root, temp } = setup(
      GENERATOR.replace(
        'const out = args.at(-1);',
        'const out = args.at(-1);\nif (!isAbsolute(out)) process.exit(3);',
      ).replace('import { dirname, join }', 'import { dirname, isAbsolute, join }'),
    );
    const relativeTemp = relative(process.cwd(), temp);
    expect(definitionFindings({ project, root, temp: relativeTemp, timeoutMs: 20_000, env: {} })).toEqual({
      definitions: [],
      generated: [],
    });
  });
});

it('leaves dotfiles in the definitions folder out, as a *.json glob does', () => {
  const { project, check } = setup();
  write(join(project, '.cedarloom', 'workflows', '.#dev.json'), '');
  expect(check()).toEqual({ definitions: [], generated: [] });
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
    expect(check()).toEqual(notJson('.cedarloom/workflows'));
  });

  it('definition.not-json for a link, also one that loops', ({ skip }) => {
    const { project, check } = setup();
    const workflows = join(project, '.cedarloom', 'workflows');
    link(join(workflows, 'dev.json'), join(workflows, 'copy.json'), skip);
    link(join(workflows, 'loop.json'), join(workflows, 'loop.json'), skip);
    expect(check().definitions).toEqual([
      ...notJson('.cedarloom/workflows/copy.json').definitions,
      ...notJson('.cedarloom/workflows/loop.json').definitions,
    ]);
  });

  it.skipIf(isWindows)('definition.not-json for a definitions folder reached through a link', () => {
    const { project, check } = setup();
    const elsewhere = folder();
    rmSync(join(project, '.cedarloom'), { recursive: true });
    write(join(elsewhere, 'workflows', 'dev.json'), '{"name": "dev"}');
    symlinkSync(elsewhere, join(project, '.cedarloom'));
    expect(check()).toEqual(notJson('.cedarloom/workflows'));
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

describe('reports a generator that fails with generator.failed', () => {
  it('with the exit code and the error output, once for all definitions', () => {
    const { project, check } = setup("process.stderr.write('broken');\nprocess.exit(3);\n");
    write(join(project, '.cedarloom', 'workflows', 'other.json'), JSON.stringify({ name: 'other' }));
    expect(check().definitions).toEqual([
      { code: 'generator.failed', severity: 'error', params: { exitCode: 3, signal: null, stderr: 'broken' } },
    ]);
  });

  it('with exit code 1 and the stack trace for a generator that throws', () => {
    const { check } = setup("throw new Error('runner.js missing');\n");
    expect(check().definitions).toEqual([
      {
        code: 'generator.failed',
        severity: 'error',
        params: { exitCode: 1, signal: null, stderr: expect.stringContaining('Error: runner.js missing') },
      },
    ]);
  });

  it('with SIGKILL for a generator that does not end in time', () => {
    const { check } = setup('setInterval(() => {}, 1000);\n');
    expect(check(500).definitions).toEqual([
      { code: 'generator.failed', severity: 'error', params: { exitCode: null, signal: 'SIGKILL', stderr: '' } },
    ]);
  });

  it('with the error output for an exit code of 1 with an empty refusal list', () => {
    const { check } = setup("console.log('[]');\nprocess.stderr.write('ENAMETOOLONG');\nprocess.exit(1);\n");
    expect(check().definitions).toEqual([
      { code: 'generator.failed', severity: 'error', params: { exitCode: 1, signal: null, stderr: 'ENAMETOOLONG' } },
    ]);
  });
});

describe('reports output it cannot read with generator.output-unknown', () => {
  it('for output that is no refusal list', () => {
    const { check } = setup("console.log('done');\n");
    expect(check().definitions).toEqual([
      { code: 'generator.output-unknown', severity: 'error', params: { output: 'done\n' } },
    ]);
  });

  it('for an exit code of 0 with a refusal', () => {
    const { check } = setup(
      "console.log(JSON.stringify([{ file: process.argv[2], field: '/name', rule: 'refused' }]));\n",
    );
    expect(check().definitions).toEqual([
      { code: 'generator.output-unknown', severity: 'error', params: { output: expect.stringContaining('"/name"') } },
    ]);
  });

  it('for a file whose header names no definition', () => {
    const { check } = setup(`import { mkdirSync, writeFileSync } from 'node:fs';
const out = process.argv.at(-1);
mkdirSync(out + '/skills/x', { recursive: true });
writeFileSync(out + '/skills/x/SKILL.md', 'x');
console.log('[]');
`);
    expect(check().definitions).toEqual([
      { code: 'generator.output-unknown', severity: 'error', params: { output: 'skills/x/SKILL.md' } },
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
