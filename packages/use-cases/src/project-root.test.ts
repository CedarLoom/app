import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { projectRoot } from './project-root.ts';

// statSync fails with `statFails.code` while it is set.
const statFails = vi.hoisted(() => ({ code: '' }));
vi.mock('node:fs', async (load) => {
  const fs = await load<typeof import('node:fs')>();
  const statSync = vi.fn(fs.statSync).mockImplementation((path, options) => {
    const { code } = statFails;
    if (code !== '') throw Object.assign(new Error(`${code}: stat failed`), { code });
    return fs.statSync(path, options);
  });
  return { ...fs, statSync };
});

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A working tree with a .git folder.
const repository = (): string => {
  const main = mkdtempSync(join(tmpdir(), 'cedarloom-root-'));
  folders.push(main);
  mkdirSync(join(main, '.git', 'objects'), { recursive: true });
  return main;
};

it('finds the nearest working tree above a folder, a .git file of a linked worktree included', () => {
  const main = repository();
  const worktree = join(main, 'linked');
  mkdirSync(join(worktree, 'deep'), { recursive: true });
  writeFileSync(join(worktree, '.git'), 'gitdir: ../.git/worktrees/linked\n');
  expect(projectRoot(join(main, 'docs'))).toBe(main);
  expect(projectRoot(join(worktree, 'deep'))).toBe(worktree);
});

it('follows a .git link to a folder, as Git does', () => {
  const main = repository();
  const linked = join(main, 'linked');
  mkdirSync(linked);
  symlinkSync(join(main, '.git'), join(linked, '.git'), 'junction');
  expect(projectRoot(linked)).toBe(linked);
});

it('refuses a folder inside .git with project.not-found, as no working tree', () => {
  const main = repository();
  const cwd = join(main, '.git', 'objects');
  expect(projectRoot(cwd)).toEqual({ code: 'project.not-found', params: { cwd } });
});

it('refuses a .git file that does not start with "gitdir: " with project.git-unreadable, not the tree above', () => {
  const main = repository();
  const inner = join(main, 'inner');
  mkdirSync(inner);
  writeFileSync(join(inner, '.git'), 'gitdir:../x\n');
  expect(projectRoot(inner)).toEqual({ code: 'project.git-unreadable', params: { path: join(inner, '.git') } });
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'refuses a .git entry it may not read with project.git-unreadable',
  () => {
    const main = repository();
    const locked = join(main, 'locked');
    mkdirSync(join(locked, 'deep'), { recursive: true });
    chmodSync(locked, 0o000);
    const found = projectRoot(join(locked, 'deep'));
    chmodSync(locked, 0o700);
    expect(found).toEqual({ code: 'project.git-unreadable', params: { path: join(locked, 'deep', '.git') } });
  },
);

it('refuses a .git link to a missing target with project.git-unreadable, not the tree above', () => {
  const main = repository();
  const inner = join(main, 'inner');
  mkdirSync(inner);
  symlinkSync(join(main, 'missing'), join(inner, '.git'), 'junction');
  expect(projectRoot(inner)).toEqual({ code: 'project.git-unreadable', params: { path: join(inner, '.git') } });
});

it('reads a working folder whose .git path is too long to exist as having no .git entry', () => {
  const main = repository();
  expect(projectRoot(join(main, 'a'.repeat(300)))).toBe(main);
});

it('follows a .git link to a "gitdir: " file', () => {
  const main = repository();
  const linked = join(main, 'linked');
  mkdirSync(linked);
  writeFileSync(join(main, 'gitfile'), 'gitdir: .git\n');
  symlinkSync(join(main, 'gitfile'), join(linked, '.git'));
  expect(projectRoot(linked)).toBe(linked);
});

it('passes on a stat error that does not mean the path is unreachable', () => {
  const main = repository();
  statFails.code = 'EIO';
  try {
    expect(() => projectRoot(main)).toThrow(expect.objectContaining({ code: 'EIO' }));
  } finally {
    statFails.code = '';
  }
});
