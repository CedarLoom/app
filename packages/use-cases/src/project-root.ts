import { type BigIntStats, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Refusal } from '@cedarloom/core';
import { isUnreachable } from './plugin-folder.ts';
import { entryAt, errorCode, readFound } from './project-files.ts';

const GITDIR = Buffer.from('gitdir: ');

// What is at path, its links followed; undefined when nothing is, also when a folder on the way is a file or the name is too long to exist.
const statAt = (path: string): BigIntStats | undefined => {
  try {
    return statSync(path, { throwIfNoEntry: false, bigint: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOTDIR' || code === 'ENAMETOOLONG') return undefined;
    throw error;
  }
};

// Whether the regular file at path, its links followed, starts with "gitdir: "; a file that cannot be read is no root.
const isGitFile = (path: string): boolean => {
  try {
    const head = readFound(realpathSync.native(path), GITDIR.length);
    return typeof head === 'object' && GITDIR.equals(head.bytes);
  } catch {
    return false;
  }
};

/**
 * What the .git entry of folder makes of it, its links followed: a root when it is a folder or a file that starts with
 * "gitdir: ", invalid when it is anything else or a link that leads nowhere; below is the folder the walk came up from.
 */
const gitEntry = (folder: string, below: string | undefined): 'root' | 'none' | 'inside' | 'invalid' => {
  const git = join(folder, '.git');
  // A link that leads nowhere is seen as the link itself, which is invalid.
  const info = statAt(git) ?? entryAt(git);
  if (info === undefined) return 'none';
  if (info.isDirectory()) {
    const from = below === undefined ? undefined : statAt(below);
    return from?.ino === info.ino && from.dev === info.dev ? 'inside' : 'root';
  }
  return info.isFile() && isGitFile(git) ? 'root' : 'invalid';
};

/**
 * The top folder of the Git working tree that holds cwd: the nearest folder whose .git entry is a folder or a file that
 * starts with "gitdir: "; no git process, so no git setting moves it. Refused inside a .git folder, which is no working
 * tree, and at any other .git entry or one the app cannot reach.
 */
export const projectRoot = (cwd: string): string | Refusal => {
  let below: string | undefined;
  for (let folder = resolve(cwd); ; below = folder, folder = dirname(folder)) {
    let entry: ReturnType<typeof gitEntry>;
    try {
      entry = gitEntry(folder, below);
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      entry = 'invalid';
    }
    if (entry === 'root') return folder;
    if (entry === 'invalid') return { code: 'project.git-unreadable', params: { path: join(folder, '.git') } };
    if (entry === 'inside' || dirname(folder) === folder) return { code: 'project.not-found', params: { cwd } };
  }
};
