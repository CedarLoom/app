import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { projectRoot } from './project-root.ts';

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('finds the nearest working tree above a folder, a .git file of a linked worktree included', () => {
  const main = mkdtempSync(join(tmpdir(), 'cedarloom-root-'));
  folders.push(main);
  const worktree = join(main, 'linked');
  mkdirSync(join(main, '.git'));
  mkdirSync(join(worktree, 'deep'), { recursive: true });
  writeFileSync(join(worktree, '.git'), 'gitdir: ../.git/worktrees/linked\n');
  expect(projectRoot(join(main, 'docs'))).toBe(main);
  expect(projectRoot(join(worktree, 'deep'))).toBe(worktree);
});
