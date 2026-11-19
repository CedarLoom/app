import { join } from 'node:path';
import { entryAt } from './project-files.ts';

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

/** The first link from the project root down to `path`, the path itself included, as a project-relative path. */
export const linkOnWay = (root: string, path: string): string | undefined => {
  const parts = path.split('/');
  for (let end = 1; end <= parts.length; end += 1) {
    const way = parts.slice(0, end).join('/');
    const info = entryAt(join(root, way));
    if (info === undefined) return undefined;
    if (info.isSymbolicLink()) return way;
  }
  return undefined;
};
