import type { Finding } from '@cedarloom/core';
import { definitionBytes, definitionFileNames, Named, nameMismatch, PROJECT_FOLDER } from './definition-files.ts';
import { headerName } from './generated-header.ts';
import { type GeneratorRun, generate, unknownOutput } from './generator-run.ts';
import { generatedFiles, orphanedPaths, stalePaths } from './stale-paths.ts';

/** The checks of the project's definitions: the definitions check's findings, and those of the generated files. */
export interface DefinitionFindings {
  definitions: Finding[];
  generated: Finding[];
}

interface Definition {
  /** The project-relative path of its file. */
  path: string;
  bytes: Buffer;
  /** The name the generator writes its outputs under, once it accepted the definition. */
  name: string | undefined;
}

const notJson = (path: string): Finding => ({ code: 'definition.not-json', severity: 'error', params: { path } });

// One definition file, or why it cannot be one: unreadable, not JSON, or named other than its file.
const read = (project: string, file: string): Definition | Finding | undefined => {
  const path = `${PROJECT_FOLDER}/${file}`;
  const bytes = definitionBytes(project, path);
  // Removed since the folder was listed.
  if (bytes === 'absent') return undefined;
  if (bytes === 'unreadable') return notJson(path);
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    return notJson(path);
  }
  const mismatch = nameMismatch(path, json);
  if (mismatch !== undefined) return { ...mismatch, severity: 'error' };
  const named = Named.safeParse(json);
  return { path, bytes, name: named.success ? named.data.name : undefined };
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
  const { files: generated, unreadable } = generatedFiles(project);
  const orphans = orphanedPaths(generated, names);
  const present = names.flatMap((name) => {
    const own = new Map([...outputs].filter(([, bytes]) => ownerOf(bytes) === name));
    return stale(name, [...stalePaths(project, name, own, generated), ...(orphans.get(name) ?? [])].toSorted());
  });
  const gone = allRead
    ? [...orphans].filter(([name]) => !names.includes(name)).flatMap(([name, paths]) => stale(name, paths))
    : [];
  return { definitions: [], generated: [...present, ...gone, ...unreadable] };
};

/**
 * Runs the generator on the project's definitions in one run into a temporary folder, as a project regenerates them,
 * and compares its outputs with the project.
 */
export const definitionFindings = (request: GeneratorRun & { project: string }): DefinitionFindings => {
  const files = definitionFileNames(request.project, PROJECT_FOLDER);
  if (files === 'unreadable') return { definitions: [notJson(PROJECT_FOLDER)], generated: [] };
  const found = files.map((file) => read(request.project, file)).filter((entry) => entry !== undefined);
  const refused = found.filter((entry): entry is Finding => 'code' in entry);
  const definitions = found.filter((entry): entry is Definition => 'bytes' in entry);
  if (refused.length > 0 && definitions.length === 0) return { definitions: refused, generated: [] };
  // Nothing to generate, but the files of removed definitions may be left.
  if (definitions.length === 0) return compared(request.project, [], new Map(), true);
  const generated = generate(
    definitions.map(({ bytes }) => bytes),
    request,
  );
  if ('finding' in generated) return { definitions: [...refused, generated.finding], generated: [] };
  if ('refusals' in generated) {
    const invalid = definitions.flatMap(({ path }, index): Finding[] => {
      const count = generated.refusals[index]?.length ?? 0;
      return count === 0 ? [] : [{ code: 'definition.invalid', severity: 'error', params: { path, count } }];
    });
    return { definitions: [...refused, ...invalid], generated: [] };
  }
  const result = compared(request.project, definitions, generated.outputs, refused.length === 0);
  return { definitions: [...refused, ...result.definitions], generated: result.generated };
};
