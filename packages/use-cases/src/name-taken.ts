import { readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Refusal } from '@cedarloom/core';
import { PROJECT_FOLDER } from './definition-files.ts';
import { reached } from './plugin-folder.ts';
import { entryAt } from './project-files.ts';

// The folders from cwd up to the project root, each of which may hold a .claude folder Claude Code reads.
const foldersUp = (cwd: string, root: string): string[] => {
  const below = relative(root, resolve(cwd));
  // A cwd outside the project leaves only the root's, so no path outside the project is named.
  if (below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) return [root];
  const folders: string[] = [];
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    folders.push(folder);
    if (folder === root || dirname(folder) === folder) return folders;
  }
};

// An entry the app cannot reach is one Claude Code cannot load either.
const entryTaken = (path: string): boolean => reached(() => entryAt(path)) !== undefined;

// Whether a folder holds anything but folders at any depth, links not walked; a folder the app cannot list may.
const holdsFile = (folder: string): boolean =>
  reached(() => readdirSync(folder, { withFileTypes: true }))?.some(
    (entry) => !entry.isDirectory() || holdsFile(join(folder, entry.name)),
  ) !== false;

// Generate and undo can leave empty folders, so a skill folder holding only folders is no use of the name.
const skillTaken = (path: string): boolean => {
  const entry = reached(() => entryAt(path));
  return entry !== undefined && (!entry.isDirectory() || holdsFile(path));
};

/**
 * One `workflow.name-taken` per project path that already uses the workflow name: a skill folder, command or workflow
 * script named `<name>` or `<name>-run` in a `.claude/` from cwd up to the project root, or the project definition.
 */
export const nameTaken = (cwd: string, root: string, name: string): Refusal[] => {
  const claude = foldersUp(cwd, root).flatMap((folder) =>
    [name, `${name}-run`].flatMap((each): [string, (path: string) => boolean][] => [
      [join(folder, '.claude', 'skills', each), skillTaken],
      [join(folder, '.claude', 'commands', `${each}.md`), entryTaken],
      [join(folder, '.claude', 'workflows', `${each}.js`), entryTaken],
    ]),
  );
  return [...claude, [join(root, PROJECT_FOLDER, `${name}.json`), entryTaken] as const]
    .filter(([path, taken]) => taken(path))
    .map(([path]) => ({
      code: 'workflow.name-taken',
      params: { name, path: relative(root, path).replaceAll(sep, '/') },
    }));
};
