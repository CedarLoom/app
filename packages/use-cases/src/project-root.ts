import { type BigIntStats, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Refusal } from '@cedarloom/core';
import { errorCode, readFound } from './project-files.ts';

const GITDIR = Buffer.from('gitdir: ');

// What is at path, its links followed as Git follows them; undefined when nothing is.
const statAt = (path: string): BigIntStats | undefined => {
  try {
    return statSync(path, { throwIfNoEntry: false, bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOTDIR') return undefined;
    throw error;
  }
};

/** What the .git entry of folder makes of it, as Git reads it; below is the folder the walk came up from. */
const gitEntry = (folder: string, below: string | undefined): 'root' | 'none' | 'inside' | 'invalid' => {
  const git = join(folder, '.git');
  const info = statAt(git);
  if (info === undefined) return 'none';
  if (info.isDirectory()) {
    const from = below === undefined ? undefined : statAt(below);
    return from?.ino === info.ino && from.dev === info.dev ? 'inside' : 'root';
  }
  const head = info.isFile() ? readFound(git, GITDIR.length) : 'not-file';
  return typeof head === 'object' && GITDIR.equals(head.bytes) ? 'root' : 'invalid';
};

/**
 * The top folder of the Git working tree that holds cwd, by its .git folder or "gitdir: " file; no git process, so no
 * git setting moves it. Refused inside a .git folder, which is no working tree, and at a .git entry Git would refuse.
 */
export const projectRoot = (cwd: string): string | Refusal => {
  let below: string | undefined;
  for (let folder = resolve(cwd); ; below = folder, folder = dirname(folder)) {
    let entry: ReturnType<typeof gitEntry>;
    try {
      entry = gitEntry(folder, below);
    } catch (error) {
      if (errorCode(error) === undefined) throw error;
      entry = 'invalid';
    }
    if (entry === 'root') return folder;
    if (entry === 'invalid') return { code: 'project.git-unreadable', params: { path: join(folder, '.git') } };
    if (entry === 'inside' || dirname(folder) === folder) return { code: 'project.not-found', params: { cwd } };
  }
};
