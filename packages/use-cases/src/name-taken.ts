import { dirname, join, relative, resolve } from 'node:path';
import type { Refusal } from '@cedarloom/core';
import { PROJECT_FOLDER } from './definition-files.ts';
import { reached } from './plugin-folder.ts';
import { entryAt } from './project-files.ts';

// The folders from cwd up to the project root, each of which may hold a .claude folder Claude Code reads.
const foldersUp = (cwd: string, root: string): string[] => {
  const folders: string[] = [];
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    folders.push(folder);
    if (folder === root || dirname(folder) === folder) return folders;
  }
};

/**
 * One `workflow.name-taken` per project path that already uses the workflow name: a skill folder, command or workflow
 * script named `<name>` or `<name>-run` in a `.claude/` from cwd up to the project root, or the project definition.
 */
export const nameTaken = (cwd: string, root: string, name: string): Refusal[] => {
  const claude = foldersUp(cwd, root).flatMap((folder) =>
    [name, `${name}-run`].flatMap((each) =>
      [`skills/${each}`, `commands/${each}.md`, `workflows/${each}.js`].map((path) =>
        relative(root, join(folder, '.claude', path)).replaceAll('\\', '/'),
      ),
    ),
  );
  // An entry the app cannot reach is one Claude Code cannot load either.
  return [...claude, `${PROJECT_FOLDER}/${name}.json`]
    .filter((path) => reached(() => entryAt(join(root, path))) !== undefined)
    .map((path) => ({ code: 'workflow.name-taken', params: { name, path } }));
};
