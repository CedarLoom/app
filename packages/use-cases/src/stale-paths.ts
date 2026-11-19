import { join } from 'node:path';
import { filesBelow } from './files-below.ts';
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

// Git for Windows checks text out with CRLF by default; the generator writes LF.
const withLf = (bytes: Buffer): Buffer => Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');

// The files a generator run for name wrote into the project before: those of its skill folder and its workflow script that carry the mark.
const generatedBefore = (project: string, name: string): string[] => {
  const skill = `.claude/skills/${name}`;
  const inSkill =
    reached(() => linkOnWay(project, skill) ?? null) === null
      ? (reached(() => filesBelow(join(project, skill))) ?? []).map((path) => `${skill}/${path}`)
      : [];
  return [...inSkill, `.claude/workflows/${name}.js`].filter((path) => bytesAt(project, path)?.includes(MARK));
};

/**
 * The project-relative paths where the project's `.claude/` differs from the generator's outputs for the definition
 * name: a file changed or missing, or a generated file of that name the outputs no longer hold.
 */
export const stalePaths = (project: string, name: string, outputs: ReadonlyMap<string, Buffer>): string[] => {
  const expected = new Map([...outputs].map(([path, bytes]) => [`.claude/${path}`, bytes]));
  const differing = [...expected].filter(([path, bytes]) => {
    const found = bytesAt(project, path);
    return found === undefined || !withLf(found).equals(bytes);
  });
  const extra = generatedBefore(project, name).filter((path) => !expected.has(path));
  return [...differing.map(([path]) => path), ...extra].toSorted();
};
