import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { reached } from './plugin-folder.ts';
import { readFound } from './project-files.ts';
import { linkOnWay } from './write-roots.ts';

// The generator's mark at the end of the header of every file it writes; a file without it was not generated.
const MARK = ': edit the definition, not this file.';

// A project file's bytes; undefined for anything but a regular file reached without a link, as a write would refuse it.
const bytesAt = (project: string, path: string): Buffer | undefined => {
  if (reached(() => linkOnWay(project, path) ?? null) !== null) return undefined;
  const found = reached(() => readFound(join(project, path)));
  return typeof found === 'object' ? found.bytes : undefined;
};

// The files a generator run for name wrote into the project before: those of its skill folder and its workflow script that carry the mark.
const generatedBefore = (project: string, name: string): string[] => {
  const skill = `.claude/skills/${name}`;
  const entries =
    reached(() => linkOnWay(project, skill) ?? null) === null
      ? (reached(() => readdirSync(join(project, skill), { recursive: true, withFileTypes: true })) ?? [])
      : [];
  const inSkill = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(project, join(entry.parentPath, entry.name)).split(sep).join('/'));
  return [...inSkill, `.claude/workflows/${name}.js`].filter((path) => bytesAt(project, path)?.includes(MARK));
};

// A name that stays one folder: "", "." or ".." would widen the search to its parent.
const isPlainName = (name: string): boolean => name !== '' && name !== '.' && name !== '..';

/**
 * The project-relative paths where the project's `.claude/` differs from the generator's outputs for the definition
 * name: a file changed or missing, or a generated file of that name the outputs no longer hold.
 */
export const stalePaths = (project: string, name: string, outputs: ReadonlyMap<string, Buffer>): string[] => {
  const expected = new Map([...outputs].map(([path, bytes]) => [`.claude/${path}`, bytes]));
  const differing = [...expected].filter(([path, bytes]) => bytesAt(project, path)?.equals(bytes) !== true);
  const extra = isPlainName(name) ? generatedBefore(project, name).filter((path) => !expected.has(path)) : [];
  return [...differing.map(([path]) => path), ...extra].toSorted();
};
