import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { nameTaken } from './name-taken.ts';

// A project root holding the files given, each with any text.
const projectWith = (...files: string[]): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cedarloom-names-')));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'taken\n');
  }
  return root;
};

it.each([
  ['a skill folder', '.claude/skills/mine/notes.md', '.claude/skills/mine'],
  ['a command', '.claude/commands/mine.md', '.claude/commands/mine.md'],
  ['a command of the run name', '.claude/commands/mine-run.md', '.claude/commands/mine-run.md'],
  ['a workflow in a parent folder', 'sub/.claude/workflows/mine.js', 'sub/.claude/workflows/mine.js'],
  ['a run workflow in a parent folder', 'sub/.claude/workflows/mine-run.js', 'sub/.claude/workflows/mine-run.js'],
  ['a definition', '.cedarloom/workflows/mine.json', '.cedarloom/workflows/mine.json'],
])('refuses a name %s uses with workflow.name-taken naming its path', (_, file, path) => {
  const root = projectWith(file);
  expect(nameTaken(join(root, 'sub', 'deeper'), root, 'mine')).toEqual([
    { code: 'workflow.name-taken', params: { name: 'mine', path } },
  ]);
});

it('refuses with one workflow.name-taken per path, and not for a folder beside the way up or another name', () => {
  const root = projectWith(
    '.claude/commands/mine.md',
    '.claude/workflows/mine.js',
    'other/.claude/skills/mine/SKILL.md',
    '.claude/skills/mine-two/SKILL.md',
  );
  expect(nameTaken(join(root, 'sub'), root, 'mine')).toEqual([
    { code: 'workflow.name-taken', params: { name: 'mine', path: '.claude/commands/mine.md' } },
    { code: 'workflow.name-taken', params: { name: 'mine', path: '.claude/workflows/mine.js' } },
  ]);
});

it('takes no skill folder that holds only folders as a use of the name', () => {
  const root = projectWith('.claude/skills/other/SKILL.md');
  mkdirSync(join(root, '.claude/skills/mine/agents/deeper'), { recursive: true });
  expect(nameTaken(root, root, 'mine')).toEqual([]);
});

it.skipIf(process.platform === 'win32')(
  'takes a skill folder holding a link, also one to an empty folder, as used',
  () => {
    const root = projectWith();
    mkdirSync(join(root, '.claude/skills/mine/agents'), { recursive: true });
    mkdirSync(join(root, 'empty'));
    symlinkSync(join(root, 'empty'), join(root, '.claude/skills/mine/agents/link'));
    expect(nameTaken(root, root, 'mine')).toEqual([
      { code: 'workflow.name-taken', params: { name: 'mine', path: '.claude/skills/mine' } },
    ]);
  },
);

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'takes a skill folder it cannot list as used',
  () => {
    const root = projectWith();
    mkdirSync(join(root, '.claude/skills/mine'), { recursive: true });
    chmodSync(join(root, '.claude/skills/mine'), 0o300);
    try {
      expect(nameTaken(root, root, 'mine')).toEqual([
        { code: 'workflow.name-taken', params: { name: 'mine', path: '.claude/skills/mine' } },
      ]);
    } finally {
      chmodSync(join(root, '.claude/skills/mine'), 0o700);
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'looks in a folder with a backslash in its name, where it is no separator',
  () => {
    const root = projectWith('a\\b/.claude/commands/mine.md', 'a/b/.claude/commands/mine-run.md');
    expect(nameTaken(join(root, 'a\\b'), root, 'mine')).toEqual([
      { code: 'workflow.name-taken', params: { name: 'mine', path: 'a\\b/.claude/commands/mine.md' } },
    ]);
  },
);

it('looks only in the project root when cwd is outside it', () => {
  const base = projectWith('.claude/commands/mine.md', 'project/.claude/commands/other.md', 'elsewhere/notes.md');
  expect(nameTaken(join(base, 'elsewhere'), join(base, 'project'), 'mine')).toEqual([]);
});

it.each([
  ['plain', '---\nname: mine\n---\nRun.\n'],
  ['quoted, of the run name, with CRLF line ends', '---\r\ndescription: Runs.\r\nname: "mine-run"\r\n---\r\nRun.\r\n'],
])('refuses a name the front matter of a skill in another folder gives it, %s', (_, text) => {
  const root = projectWith('.claude/skills/other/SKILL.md', '.claude/skills/near/SKILL.md');
  writeFileSync(join(root, '.claude/skills/other/SKILL.md'), text);
  writeFileSync(join(root, '.claude/skills/near/SKILL.md'), '---\nname: mine-two\n---\nname: mine\n');
  expect(nameTaken(root, root, 'mine')).toEqual([
    { code: 'workflow.name-taken', params: { name: 'mine', path: '.claude/skills/other/SKILL.md' } },
  ]);
});

it('stops at the project root also when its path ends in a separator', () => {
  const base = projectWith('.claude/commands/mine.md', 'project/notes.md');
  expect(nameTaken(join(base, 'project'), join(base, 'project') + sep, 'mine')).toEqual([]);
});

// A small stack stands in for a depth macOS and Linux paths do not reach; Windows may refuse a path this long.
it.skipIf(process.platform === 'win32')('walks a skill folder hundreds of folders deep without recursion', () => {
  const root = projectWith();
  mkdirSync(join(root, '.claude/skills/mine', ...Array.from({ length: 400 }, () => 'a')), { recursive: true });
  const script = `
    import { nameTaken } from ${JSON.stringify(new URL('name-taken.ts', import.meta.url).href)};
    process.stdout.write(JSON.stringify(nameTaken(process.argv[1], process.argv[1], 'mine')));
  `;
  const args = ['--stack-size=100', '--input-type=module', '--eval', script, root];
  expect(execFileSync(process.execPath, args, { encoding: 'utf8' })).toBe('[]');
});
