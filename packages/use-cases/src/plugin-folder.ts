import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Finding } from '@cedarloom/core';

// The folders the app runs or reads from a plugin: the generator and the shipped definitions.
const PARTS = ['generator', 'definitions'];

/** Why the plugin folder has no workflow generator, from before generator/generate.mjs and definitions/; undefined when it has both. */
export const tooOldFinding = (root: string, version: string | null): Finding | undefined => {
  const generator = statSync(join(root, 'generator', 'generate.mjs'), { throwIfNoEntry: false });
  const definitions = statSync(join(root, 'definitions'), { throwIfNoEntry: false });
  if (generator?.isFile() && definitions?.isDirectory()) return undefined;
  return { code: 'plugin.too-old', severity: 'error', params: { root, version } };
};

// Where path leads, or undefined for a link that leads nowhere.
const realOf = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
};

/** Whether the version folder is no link and its generator and definitions, each entry included, resolve inside it. */
export const isContained = (root: string): boolean => {
  if (lstatSync(root).isSymbolicLink()) return false;
  const real = realpathSync(root);
  const inside = (path: string): boolean => {
    const target = realOf(path);
    if (target === undefined) return false;
    const rel = relative(real, target);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  return PARTS.every((part) => {
    const folder = join(root, part);
    return inside(folder) && readdirSync(folder).every((entry) => inside(join(folder, entry)));
  });
};
