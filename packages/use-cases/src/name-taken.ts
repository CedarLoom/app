import { readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Refusal } from '@cedarloom/core';
import { PROJECT_FOLDER } from './definition-files.ts';
import { reached } from './plugin-folder.ts';
import { entryAt, readFound } from './project-files.ts';

// The folders from cwd up to the project root, each of which may hold a .claude folder Claude Code reads.
const foldersUp = (cwd: string, root: string): string[] => {
  const below = relative(root, resolve(cwd));
  // A cwd outside the project leaves only the root's, so no path outside the project is named.
  if (below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) return [root];
  // Built from the root down, so the walk ends at the root however cwd spells it.
  const names = below.split(sep).filter((name) => name !== '');
  return [...names.map((_, up) => join(root, ...names.slice(0, names.length - up))), root];
};

// An entry the app cannot reach is one Claude Code cannot load either.
const entryTaken = (path: string): boolean => reached(() => entryAt(path)) !== undefined;

// Whether a folder holds anything but folders at any depth, links not walked; a folder the app cannot list may.
const holdsFile = (folder: string): boolean =>
  reached(() => readdirSync(folder, { withFileTypes: true, recursive: true }))?.some(
    (entry) => !entry.isDirectory(),
  ) !== false;

// Generate and undo can leave empty folders, so a skill folder holding only folders is no use of the name.
const skillTaken = (path: string): boolean => {
  const entry = reached(() => entryAt(path));
  return entry !== undefined && (!entry.isDirectory() || holdsFile(path));
};

type Check = [path: string, taken: (path: string) => boolean];

// The front matter sits at the top of SKILL.md.
const FRONT_LIMIT = 64 * 1024;
// shortcut: reads a one-line, plain or quoted `name:` only; take a YAML parser once skills use other forms.
const frontName = (text: string): string | undefined => {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  return front === undefined ? undefined : /^name:[ \t]*(["']?)(.*?)\1(?:[ \t]+#.*)?[ \t]*\r?$/m.exec(front)?.[2];
};

// Claude Code takes the front matter name of a skill as its command name, whatever the skill folder is called.
const namedSkills = (skills: string, names: string[]): Check[] =>
  (reached(() => readdirSync(skills)) ?? [])
    .filter((folder) => !names.includes(folder))
    .toSorted()
    .map(
      (folder): Check => [
        join(skills, folder, 'SKILL.md'),
        (path) => {
          const found = reached(() => readFound(path, FRONT_LIMIT));
          const named = typeof found === 'object' ? frontName(found.bytes.toString('utf8')) : undefined;
          return named !== undefined && names.includes(named);
        },
      ],
    );

/**
 * One `workflow.name-taken` per project path that already uses the workflow name: a skill folder, command or workflow
 * script named `<name>` or `<name>-run`, or a skill whose front matter names it so, in a `.claude/` from cwd up to the
 * project root, or the project definition.
 */
export const nameTaken = (cwd: string, root: string, name: string): Refusal[] => {
  const names = [name, `${name}-run`];
  const claude = foldersUp(cwd, root).flatMap((folder) =>
    names
      .flatMap((each): Check[] => [
        [join(folder, '.claude', 'skills', each), skillTaken],
        [join(folder, '.claude', 'commands', `${each}.md`), entryTaken],
        [join(folder, '.claude', 'workflows', `${each}.js`), entryTaken],
      ])
      .concat(namedSkills(join(folder, '.claude', 'skills'), names)),
  );
  return [...claude, [join(root, PROJECT_FOLDER, `${name}.json`), entryTaken] as const]
    .filter(([path, taken]) => taken(path))
    .map(([path]) => ({
      code: 'workflow.name-taken',
      params: { name, path: relative(root, path).replaceAll(sep, '/') },
    }));
};
