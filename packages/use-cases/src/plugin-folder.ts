import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Finding } from '@cedarloom/core';
import { errorCode } from './project-files.ts';

// What the app cannot reach counts as absent: a missing path, a link loop, a folder it may not read.
const UNREACHABLE = new Set<unknown>(['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM']);
const reached = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch (error) {
    if (UNREACHABLE.has(errorCode(error))) return undefined;
    throw error;
  }
};

/** What is at path, its links followed; undefined when the app cannot reach it. */
export const statOf = (path: string) => reached(() => statSync(path));

/** Where path leads, its links followed; undefined when the app cannot reach it. */
export const realOf = (path: string): string | undefined => reached(() => realpathSync.native(path));

/** Why the plugin folder has no workflow generator, from before generator/generate.mjs and definitions/; undefined when it has both. */
export const tooOldFinding = (root: string, version: string | null): Finding | undefined => {
  const generator = statOf(join(root, 'generator', 'generate.mjs'));
  const definitions = statOf(join(root, 'definitions'));
  if (generator?.isFile() && definitions?.isDirectory()) return undefined;
  return { code: 'plugin.too-old', severity: 'error', params: { root, version } };
};

// Whether path, its links followed, lies inside folder, its links followed too.
const isInside = (path: string, folder: string): boolean => {
  const [target, real] = [realOf(path), realOf(folder)];
  if (target === undefined || real === undefined) return false;
  const rel = relative(real, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

// Whether every link below folder, at any depth, leads inside root; links are checked, never walked, and an unreadable folder fails.
const linksStayIn = (folder: string, root: string): boolean =>
  reached(() => readdirSync(folder))?.every((name) => {
    const path = join(folder, name);
    const entry = reached(() => lstatSync(path));
    if (entry?.isSymbolicLink()) return isInside(path, root);
    return entry !== undefined && (!entry.isDirectory() || linksStayIn(path, root));
  }) === true;

/** Whether the version folder is a folder, no link, and every link in it leads inside it, so no file the app runs or reads lies elsewhere. */
export const isContained = (root: string): boolean =>
  reached(() => lstatSync(root))?.isDirectory() === true && linksStayIn(root, root);
