import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Finding } from '@cedarloom/core';
import { errorCode } from './project-files.ts';

/** Why the plugin folder has no workflow generator, from before generator/generate.mjs and definitions/; undefined when it has both. */
export const tooOldFinding = (root: string, version: string | null): Finding | undefined => {
  const generator = statSync(join(root, 'generator', 'generate.mjs'), { throwIfNoEntry: false });
  const definitions = statSync(join(root, 'definitions'), { throwIfNoEntry: false });
  if (generator?.isFile() && definitions?.isDirectory()) return undefined;
  return { code: 'plugin.too-old', severity: 'error', params: { root, version } };
};

// Where path leads, or undefined for a link that leads nowhere or in a loop.
const realOf = (path: string): string | undefined => {
  try {
    return realpathSync.native(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return undefined;
    throw error;
  }
};

/** Whether path, its links followed, lies inside folder, its links followed too. */
export const isInside = (path: string, folder: string): boolean => {
  const [target, real] = [realOf(path), realOf(folder)];
  if (target === undefined || real === undefined) return false;
  const rel = relative(real, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

// Whether every link below folder, at any depth, leads inside root; links are checked, never walked.
const linksStayIn = (folder: string, root: string): boolean =>
  readdirSync(folder).every((name) => {
    const path = join(folder, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) return isInside(path, root);
    return !entry.isDirectory() || linksStayIn(path, root);
  });

/** Whether the version folder is no link and every link in it leads inside it, so no file the app runs or reads lies elsewhere. */
export const isContained = (root: string): boolean => !lstatSync(root).isSymbolicLink() && linksStayIn(root, root);
