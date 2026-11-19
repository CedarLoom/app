import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from '@cedarloom/core';
import { type GeneratorRun, generate } from './generator-run.ts';
import { isUnreachable, reached } from './plugin-folder.ts';
import { errorCode, readFound } from './project-files.ts';
import { stalePaths } from './stale-paths.ts';

/** The checks of the project's definitions: the definitions check's findings, and those of the generated files. */
export interface DefinitionFindings {
  definitions: Finding[];
  generated: Finding[];
}

const FOLDER = '.cedarloom/workflows';

const notJson = (path: string): DefinitionFindings => ({
  definitions: [{ code: 'definition.not-json', severity: 'error', params: { path } }],
  generated: [],
});

// One definition file: unreadable or not JSON, refused by the generator, or generated and compared with the project.
const checked = (request: GeneratorRun & { project: string }, file: string): DefinitionFindings => {
  const path = `${FOLDER}/${file}`;
  const found = reached(() => readFound(join(request.project, path)));
  // Removed since the folder was listed.
  if (found === 'absent') return { definitions: [], generated: [] };
  if (typeof found !== 'object') return notJson(path);
  try {
    JSON.parse(found.bytes.toString('utf8'));
  } catch {
    return notJson(path);
  }
  const name = file.slice(0, -'.json'.length);
  const generated = generate(found.bytes, request);
  if ('finding' in generated) return { definitions: [generated.finding], generated: [] };
  if ('refusals' in generated) {
    const params = { name, count: generated.refusals };
    return { definitions: [{ code: 'definition.invalid', severity: 'error', params }], generated: [] };
  }
  const paths = stalePaths(request.project, name, generated.outputs);
  if (paths.length === 0) return { definitions: [], generated: [] };
  return { definitions: [], generated: [{ code: 'definition.stale', severity: 'warning', params: { name, paths } }] };
};

/** Runs the generator on each project definition into a temporary folder and compares its outputs with the project. */
export const definitionFindings = (request: GeneratorRun & { project: string }): DefinitionFindings => {
  let files: string[];
  try {
    files = readdirSync(join(request.project, FOLDER)).filter((file) => file.endsWith('.json'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { definitions: [], generated: [] };
    if (isUnreachable(error)) return notJson(FOLDER);
    throw error;
  }
  const results = files.toSorted().map((file) => checked(request, file));
  return {
    definitions: results.flatMap(({ definitions }) => definitions),
    generated: results.flatMap(({ generated }) => generated),
  };
};
