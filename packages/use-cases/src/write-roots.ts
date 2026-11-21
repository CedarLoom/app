import { join } from 'node:path';
import { isReservedName } from '@cedarloom/core';
import { entryAt, errorCode } from './project-files.ts';

// Windows ignores trailing dots and spaces in a name and compares names without case, so ".GIT." is ".git" there, and
// "GIT~1" can be its 8.3 short name, which git's own path check refuses too.
const isGit = (part: string): boolean => /^(?:\.git|git~\d+)$/i.test(part.replace(/[. ]+$/, ''));
// "\\" and ":" separate paths and name alternate data streams on Windows.
const isName = (part: string): boolean => part !== '' && part !== '.' && part !== '..' && !/[\\:\0]/.test(part);

/** Whether a project-relative path is a file below `.claude/` or `.cedarloom/workflows/` and outside every `.git` folder. */
export const inWriteRoots = (path: string): boolean => {
  const parts = path.split('/');
  if (!parts.every(isName) || parts.some(isGit)) return false;
  const [first, second] = parts;
  return (
    (first === '.claude' && parts.length > 1) || (first === '.cedarloom' && second === 'workflows' && parts.length > 2)
  );
};

/**
 * Whether each name of a path is one Windows keeps as written: none of `<>"|?*` and the control characters, no trailing
 * dot or space, which Windows drops, and no reserved device name.
 */
export const isPortable = (path: string): boolean =>
  !/[<>"|?*]/.test(path) &&
  !path.split('').some((unit) => unit < ' ') &&
  path.split('/').every((part) => !/[. ]$/.test(part) && !isReservedName(part));

/** Whether a file system call failed as one the app may not make: EACCES, or EPERM, as Windows reports a denied access. */
export const isDenied = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === 'EACCES' || code === 'EPERM';
};

// The entries from the project root down to path, the path itself included, while they exist.
function* entriesOnWay(root: string, path: string) {
  const parts = path.split('/');
  for (let end = 1; end <= parts.length; end += 1) {
    const way = parts.slice(0, end).join('/');
    const entry = entryAt(join(root, way));
    if (entry === undefined) return;
    yield { way, entry };
  }
}

/** The first link from the project root down to `path`, the path itself included, as a project-relative path. */
export const linkOnWay = (root: string, path: string): string | undefined => {
  for (const { way, entry } of entriesOnWay(root, path)) if (entry.isSymbolicLink()) return way;
  return undefined;
};

/** What the way from the project root down to a path meets first, at a project-relative path; "." is the root. */
export interface Block {
  /** A link, the path itself included; a file where a folder of the path belongs; a folder the app may not enter. */
  found: 'link' | 'file' | 'denied';
  at: string;
}

/** What the way from the project root down to `path` meets first, as a write or a read must not pass it; none when clear. */
export const blockOnWay = (root: string, path: string): Block | undefined => {
  // The folder whose entry was read last; a denied read below it means the app may not enter it.
  let folder = '.';
  try {
    for (const { way, entry } of entriesOnWay(root, path)) {
      if (entry.isSymbolicLink()) return { found: 'link', at: way };
      if (way !== path && !entry.isDirectory()) return { found: 'file', at: way };
      folder = way;
    }
  } catch (error) {
    if (isDenied(error)) return { found: 'denied', at: folder };
    throw error;
  }
  return undefined;
};
