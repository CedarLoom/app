import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from '@cedarloom/core';
import { z } from 'zod';
import { headerName } from './generated-header.ts';
import { type GeneratorRun, generate, unknownOutput } from './generator-run.ts';
import { isUnreachable, reached } from './plugin-folder.ts';
import { errorCode, readFound } from './project-files.ts';
import { generatedFiles, orphanedPaths, stalePaths } from './stale-paths.ts';
import { linkOnWay } from './write-roots.ts';

/** The checks of the project's definitions: the definitions check's findings, and those of the generated files. */
export interface DefinitionFindings {
  definitions: Finding[];
  generated: Finding[];
}

const FOLDER = '.cedarloom/workflows';

interface Definition {
  /** The project-relative path of its file. */
  path: string;
  bytes: Buffer;
  /** The name the generator writes its outputs under, once it accepted the definition. */
  name: string | undefined;
}

const notJson = (path: string): Finding => ({ code: 'definition.not-json', severity: 'error', params: { path } });
const Named = z.object({ name: z.string() });

// One definition file, or why it cannot be one: unreadable, or not JSON.
const read = (project: string, file: string): Definition | Finding | undefined => {
  const path = `${FOLDER}/${file}`;
  // Where Node.js has no O_NOFOLLOW, as on Windows, readFound alone would follow a link.
  if (reached(() => linkOnWay(project, path) ?? null) !== null) return notJson(path);
  const found = reached(() => readFound(join(project, path)));
  // Removed since the folder was listed.
  if (found === 'absent') return undefined;
  if (typeof found !== 'object') return notJson(path);
  let json: unknown;
  try {
    json = JSON.parse(found.bytes.toString('utf8'));
  } catch {
    return notJson(path);
  }
  const named = Named.safeParse(json);
  return {
    path,
    bytes: found.bytes,
    name: named.success ? named.data.name : undefined,
  };
};

// The definition files, as `.cedarloom/workflows/*.json` lists them: no dotfiles, such as an editor's lock link.
const listed = (project: string): string[] | Finding => {
  // A folder reached through a link may lie outside the project, as a definition file that is a link may.
  if (reached(() => linkOnWay(project, FOLDER) ?? null) !== null) return notJson(FOLDER);
  try {
    const files = readdirSync(join(project, FOLDER)).filter((file) => file.endsWith('.json') && !file.startsWith('.'));
    return files.toSorted();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    if (isUnreachable(error)) return notJson(FOLDER);
    throw error;
  }
};

const stale = (name: string, paths: string[]): Finding[] =>
  paths.length === 0 ? [] : [{ code: 'definition.stale', severity: 'warning', params: { name, paths } }];

// The generated check of each definition: the outputs whose header names its definition, compared with the project,
// and the generated files elsewhere whose header names it; then, when every definition file was read, the generated
// files of definitions that are gone, as an unread file may hold theirs.
const compared = (
  project: string,
  definitions: Definition[],
  outputs: Map<string, Buffer>,
  allRead: boolean,
): DefinitionFindings => {
  const names = definitions.flatMap(({ name }) => (name === undefined ? [] : [name]));
  const ownerOf = (bytes: Buffer) => names.find((name) => name === headerName(bytes));
  const unowned = [...outputs].filter(([, bytes]) => ownerOf(bytes) === undefined).map(([path]) => path);
  if (unowned.length > 0) return { definitions: [unknownOutput(unowned.join('\n')).finding], generated: [] };
  const generated = generatedFiles(project);
  const orphans = orphanedPaths(generated, names);
  const present = names.flatMap((name) => {
    const own = new Map([...outputs].filter(([, bytes]) => ownerOf(bytes) === name));
    return stale(name, [...stalePaths(project, name, own, generated), ...(orphans.get(name) ?? [])].toSorted());
  });
  const gone = allRead
    ? [...orphans].filter(([name]) => !names.includes(name)).flatMap(([name, paths]) => stale(name, paths))
    : [];
  return { definitions: [], generated: [...present, ...gone] };
};

/**
 * Runs the generator on the project's definitions in one run into a temporary folder, as a project regenerates them,
 * and compares its outputs with the project.
 */
export const definitionFindings = (request: GeneratorRun & { project: string }): DefinitionFindings => {
  const files = listed(request.project);
  if (!Array.isArray(files)) return { definitions: [files], generated: [] };
  const found = files.map((file) => read(request.project, file)).filter((entry) => entry !== undefined);
  const unreadable = found.filter((entry): entry is Finding => 'code' in entry);
  const definitions = found.filter((entry): entry is Definition => 'bytes' in entry);
  if (unreadable.length > 0 && definitions.length === 0) return { definitions: unreadable, generated: [] };
  // Nothing to generate, but the files of removed definitions may be left.
  if (definitions.length === 0) return compared(request.project, [], new Map(), true);
  const generated = generate(
    definitions.map(({ bytes }) => bytes),
    request,
  );
  if ('finding' in generated) return { definitions: [...unreadable, generated.finding], generated: [] };
  if ('refusals' in generated) {
    const invalid = definitions.flatMap(({ path }, index): Finding[] => {
      const count = generated.refusals[index] ?? 0;
      return count === 0 ? [] : [{ code: 'definition.invalid', severity: 'error', params: { path, count } }];
    });
    return { definitions: [...unreadable, ...invalid], generated: [] };
  }
  const result = compared(request.project, definitions, generated.outputs, unreadable.length === 0);
  return { definitions: [...unreadable, ...result.definitions], generated: result.generated };
};
