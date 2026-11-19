import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { filesBelow } from './files-below.ts';
import { headerName, MARK } from './generated-header.ts';
import { reached } from './plugin-folder.ts';
import { readFound } from './project-files.ts';
import { linkOnWay } from './write-roots.ts';

const SKILLS = '.claude/skills';
const WORKFLOWS = '.claude/workflows';

// A project file's bytes; undefined for anything but a regular file reached without a link, as a write would refuse it.
const bytesAt = (project: string, path: string): Buffer | undefined => {
  if (reached(() => linkOnWay(project, path) ?? null) !== null) return undefined;
  const found = reached(() => readFound(join(project, path)));
  return typeof found === 'object' ? found.bytes : undefined;
};

// Git for Windows checks text out with CRLF by default; the generator writes LF, except where it copies a file as read.
const withLf = (bytes: Buffer): Buffer => Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');

// A project folder's entries; none when a link is on the way, as it may lead outside the project, or the app cannot read it.
const entriesOf = (project: string, folder: string) =>
  reached(() => linkOnWay(project, folder) ?? null) === null
    ? (reached(() => readdirSync(join(project, folder), { withFileTypes: true })) ?? [])
    : [];

// Whether path is where a generator run for name writes: its skill folder or its workflow script.
const isOwnPath = (path: string, name: string): boolean =>
  path.startsWith(`${SKILLS}/${name}/`) || path === `${WORKFLOWS}/${name}.js`;

/** The project's files a generator run wrote before: those below a skill folder and the workflow scripts that carry the mark. */
export const generatedFiles = (project: string): Map<string, Buffer> => {
  const skills = entriesOf(project, SKILLS)
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) =>
      // Each skill folder alone, so one the app cannot read hides only its own files.
      (reached(() => filesBelow(join(project, SKILLS, name))) ?? []).map((path) => `${SKILLS}/${name}/${path}`),
    );
  const scripts = entriesOf(project, WORKFLOWS)
    .filter(({ name }) => name.endsWith('.js'))
    .map(({ name }) => `${WORKFLOWS}/${name}`);
  return new Map(
    [...skills, ...scripts].flatMap((path): [string, Buffer][] => {
      const bytes = bytesAt(project, path);
      return bytes?.includes(MARK) ? [[path, bytes]] : [];
    }),
  );
};

/**
 * The project-relative paths where the project's `.claude/` differs from the generator's outputs for the definition
 * name: a file changed or missing, or a generated file of that name the outputs no longer hold.
 */
export const stalePaths = (
  project: string,
  name: string,
  outputs: ReadonlyMap<string, Buffer>,
  generated: ReadonlyMap<string, Buffer>,
): string[] => {
  const expected = new Map([...outputs].map(([path, bytes]) => [`.claude/${path}`, bytes]));
  const differing = [...expected].filter(([path, bytes]) => {
    const found = bytesAt(project, path);
    return found === undefined || !withLf(found).equals(withLf(bytes));
  });
  const extra = [...generated.keys()].filter((path) => isOwnPath(path, name) && !expected.has(path));
  return [...differing.map(([path]) => path), ...extra].toSorted();
};

/**
 * The generated files of definitions that are gone, by the name their header gives: those whose header names none of
 * the names, outside the skill folders and workflow scripts of the names.
 */
export const orphanedPaths = (
  generated: ReadonlyMap<string, Buffer>,
  names: readonly string[],
): Map<string, string[]> => {
  const orphans = [...generated].flatMap(([path, bytes]): [string, string][] => {
    const name = headerName(bytes);
    if (name === undefined || names.includes(name) || names.some((own) => isOwnPath(path, own))) return [];
    return [[name, path]];
  });
  return new Map(
    [...Map.groupBy(orphans, ([name]) => name)]
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, entries]) => [name, entries.map(([, path]) => path).toSorted()]),
  );
};
