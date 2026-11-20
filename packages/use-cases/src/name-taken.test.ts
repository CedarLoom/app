import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
