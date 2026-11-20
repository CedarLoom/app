import { type Dirent, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { filesBelow } from './files-below.ts';
import { headerName, MARK } from './generated-header.ts';
import { isUnreachable, reached } from './plugin-folder.ts';
import { errorCode, readFound } from './project-files.ts';
import { linkOnWay } from './write-roots.ts';

const SKILLS = '.claude/skills';
const WORKFLOWS = '.claude/workflows';

// The mark sits in the header, which follows only the front matter of a few definition fields.
const HEAD = 1024 * 1024;
const DENIED = new Set<unknown>(['EACCES', 'EPERM']);

// A project file's first limit bytes; undefined for anything but a regular file reached without a link, as a write
// would refuse it.
const bytesAt = (project: string, path: string, limit: number): Buffer | undefined => {
  if (reached(() => linkOnWay(project, path) ?? null) !== null) return undefined;
  const found = reached(() => readFound(join(project, path), limit));
  return typeof found === 'object' ? found.bytes : undefined;
};

// Git for Windows checks text out with CRLF by default; the generator writes LF, except where it copies a file as read.
export const withLf = (bytes: Buffer): Buffer =>
  Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');

// A project folder's entries by list; none when a link is on the way, as it may lead outside the project.
const entriesOf = (project: string, folder: string, list: (path: string) => Dirent[]) =>
  reached(() => linkOnWay(project, folder) ?? null) === null ? list(join(project, folder)) : [];

// Whether path is where a generator run for name writes: its skill folder or its workflow script.
export const isOwnPath = (path: string, name: string): boolean =>
  path.startsWith(`${SKILLS}/${name}/`) || path === `${WORKFLOWS}/${name}.js`;

/**
 * The project's files a generator run wrote before, by their head: those below a skill folder and the workflow scripts
 * that carry the mark; and the project-relative folders among them the app may not read.
 */
export const generatedFiles = (project: string): { files: Map<string, Buffer>; unreadable: string[] } => {
  const unreadable: string[] = [];
  // A folder's entries; none when the app cannot reach it, and its path noted when the app may not read it.
  const listed = (folder: string): Dirent[] => {
    try {
      return readdirSync(folder, { withFileTypes: true });
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      if (DENIED.has(errorCode(error))) unreadable.push(relative(project, folder).split(sep).join('/'));
      return [];
    }
  };
  const skills = entriesOf(project, SKILLS, listed)
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) =>
      // Folder by folder, so one the app cannot read hides only its own files.
      filesBelow(join(project, SKILLS, name), listed).map((path) => `${SKILLS}/${name}/${path}`),
    );
  const scripts = entriesOf(project, WORKFLOWS, listed)
    .filter(({ name }) => name.endsWith('.js'))
    .map(({ name }) => `${WORKFLOWS}/${name}`);
  const files = new Map(
    [...skills, ...scripts].flatMap((path): [string, Buffer][] => {
      const head = bytesAt(project, path, HEAD);
      return head?.includes(MARK) ? [[path, head]] : [];
    }),
  );
  return { files, unreadable };
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
    // A file longer than twice the bytes differs from them even with each of its line ends read as CRLF.
    const found = bytesAt(project, path, 2 * bytes.length + 1);
    return found === undefined || !withLf(found).equals(withLf(bytes));
  });
  const extra = [...generated.keys()].filter((path) => isOwnPath(path, name) && !expected.has(path));
  return [...differing.map(([path]) => path), ...extra].toSorted();
};

/**
 * The generated files outside the skill folders and workflow scripts of the names, which no run for the names writes,
 * by the name their header gives.
 */
export const orphanedPaths = (
  generated: ReadonlyMap<string, Buffer>,
  names: readonly string[],
): Map<string, string[]> => {
  const orphans = [...generated].flatMap(([path, bytes]): [string, string][] => {
    const name = headerName(bytes);
    if (name === undefined || names.some((own) => isOwnPath(path, own))) return [];
    return [[name, path]];
  });
  return new Map(
    [...Map.groupBy(orphans, ([name]) => name)]
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, entries]) => [name, entries.map(([, path]) => path).toSorted()]),
  );
};
