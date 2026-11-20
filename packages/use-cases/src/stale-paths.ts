import { type Dirent, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Finding } from '@cedarloom/core';
import { filesBelow } from './files-below.ts';
import { headerName, MARK } from './generated-header.ts';
import { isUnreachable } from './plugin-folder.ts';
import { readFound } from './project-files.ts';
import { blockOnWay, isDenied } from './write-roots.ts';

const SKILLS = '.claude/skills';
const WORKFLOWS = '.claude/workflows';

// The mark sits in the header, which follows only the front matter of a few definition fields.
const HEAD = 1024 * 1024;

// A project file's first limit bytes; undefined for anything but a regular file reached without a link, as a write
// would refuse it.
const bytesAt = (project: string, path: string, limit: number): Buffer | { denied: string } | undefined => {
  const block = blockOnWay(project, path);
  if (block !== undefined) return block.found === 'denied' ? { denied: block.at } : undefined;
  try {
    const found = readFound(join(project, path), limit);
    return typeof found === 'object' ? found.bytes : undefined;
  } catch (error) {
    if (isDenied(error)) return { denied: path };
    if (isUnreachable(error)) return undefined;
    throw error;
  }
};

// Git for Windows checks text out with CRLF by default; the generator writes LF, except where it copies a file as read.
export const withLf = (bytes: Buffer): Buffer =>
  Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');

// Whether path is where a generator run for name writes: its skill folder or its workflow script.
export const isOwnPath = (path: string, name: string): boolean =>
  path.startsWith(`${SKILLS}/${name}/`) || path === `${WORKFLOWS}/${name}.js`;

/**
 * The project's files a generator run wrote before, by their head: those below a skill folder and the workflow scripts
 * that carry the mark; and a finding for each folder or file among them the app may not read.
 */
export const generatedFiles = (project: string): { files: Map<string, Buffer>; unreadable: Finding[] } => {
  const folders = new Set<string>();
  const deniedFiles: string[] = [];
  // No entries for an error that says the app cannot reach folder, noting folder when the app may not read it.
  const unreached = (error: unknown, folder: string): Dirent[] => {
    if (!isUnreachable(error)) throw error;
    if (isDenied(error)) folders.add(relative(project, folder).split(sep).join('/'));
    return [];
  };
  // A folder's entries; none when the app cannot reach it.
  const listed = (folder: string): Dirent[] => {
    try {
      return readdirSync(folder, { withFileTypes: true });
    } catch (error) {
      return unreached(error, folder);
    }
  };
  // A project folder's entries; none when a link or a file is on the way, as a link may lead outside the project.
  const entriesOf = (folder: string): Dirent[] => {
    const block = blockOnWay(project, folder);
    if (block?.found === 'denied') folders.add(block.at);
    return block === undefined ? listed(join(project, folder)) : [];
  };
  const skills = entriesOf(SKILLS)
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) =>
      // Folder by folder, so one the app cannot read hides only its own files.
      filesBelow(join(project, SKILLS, name), listed).map((path) => `${SKILLS}/${name}/${path}`),
    );
  const scripts = entriesOf(WORKFLOWS)
    .filter(({ name }) => name.endsWith('.js'))
    .map(({ name }) => `${WORKFLOWS}/${name}`);
  const files = new Map(
    [...skills, ...scripts].flatMap((path): [string, Buffer][] => {
      const head = bytesAt(project, path, HEAD);
      if (head === undefined || Buffer.isBuffer(head)) return head?.includes(MARK) ? [[path, head]] : [];
      if (head.denied === path) deniedFiles.push(path);
      else folders.add(head.denied);
      return [];
    }),
  );
  const unreadable = [
    ...[...folders].map(
      (path): Finding => ({ code: 'generated.folder-unreadable', severity: 'warning', params: { path } }),
    ),
    ...deniedFiles.map(
      (path): Finding => ({ code: 'generated.file-unreadable', severity: 'warning', params: { path } }),
    ),
  ];
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
    return !Buffer.isBuffer(found) || !withLf(found).equals(withLf(bytes));
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
