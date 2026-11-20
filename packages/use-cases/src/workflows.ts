import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type Finding,
  type GeneratorRefusal,
  type Refusal,
  WorkflowName,
  type WorkflowList,
  type WorkflowShown,
  type WorkflowSource,
  type WorkflowValidation,
} from '@cedarloom/core';
import { z } from 'zod';
import {
  definitionBytes,
  definitionFileNames,
  isListed,
  jsonWithin,
  nameMismatch,
  PROJECT_FOLDER,
  SHIPPED_FOLDER,
} from './definition-files.ts';
import { GENERATOR_TIMEOUT_MS, generate, jsonOf } from './generator-run.ts';
import { locatePlugin } from './plugin-locator.ts';
import { type ClaudeDirInputs, pluginsRoot } from './plugins-root.ts';
import { sha256 } from './project-files.ts';
import { projectRoot } from './project-root.ts';

export interface WorkflowsRequest extends ClaudeDirInputs {
  /** The --plugin-root folder, relative to cwd or absolute, or null to locate the installed plugin. */
  pluginRoot: string | null;
}

/** What a workflows verb found: its result, or the refusals that stopped it; findings either way. */
export interface Answer<T> {
  result: T | null;
  findings: Finding[];
  refusals: Refusal[];
}

type Definitions = WorkflowValidation['definitions'];
/** Where a source's definitions are read: the folder below base, and the path a result shows for a file in it. */
export interface Place {
  source: WorkflowSource;
  base: string;
  folder: string;
  shown: (path: string) => string;
}

const stopped = <T>(refusals: Refusal[], findings: Finding[] = []): Answer<T> => ({ result: null, findings, refusals });
export const notJson = (path: string): Refusal => ({ code: 'definition.not-json', params: { path } });
const Described = z.object({ description: z.string() });

export const projectPlace = (project: string): Place => ({
  source: 'project',
  base: project,
  folder: PROJECT_FOLDER,
  shown: (path) => path,
});
// Shipped definitions show by their absolute path, as they lie outside the project.
const shippedPlace = (root: string): Place => ({
  source: 'shipped',
  base: root,
  folder: SHIPPED_FOLDER,
  shown: (path) => join(root, path),
});

// The located plugin's shipped definitions, or null when there is no usable plugin; the locator's findings either way.
export const pluginPlace = (
  request: WorkflowsRequest,
  project: string,
): { place: Place | null; findings: Finding[] } => {
  const override = request.pluginRoot === null ? null : resolve(request.cwd, request.pluginRoot);
  const located = locatePlugin({ pluginsRoot: pluginsRoot(request), cwd: request.cwd, project, override });
  return { place: located.plugin === null ? null : shippedPlace(located.plugin.root), findings: located.findings };
};

// A verb that needs the plugin stops on the locator's errors; its other findings say which folder was tried.
export const stoppedOn = <T>(findings: Finding[]): Answer<T> =>
  stopped(
    findings.flatMap(({ code, params, severity }) => (severity === 'error' ? [{ code, params }] : [])),
    findings.filter(({ severity }) => severity !== 'error'),
  );

export const invalidName = (names: readonly string[]): Refusal | undefined => {
  const name = names.find((each) => !WorkflowName.safeParse(each).success);
  return name === undefined ? undefined : { code: 'workflow.name-invalid', params: { name } };
};

const descriptionOf = (bytes: Buffer | 'absent' | 'unreadable'): string | null => {
  if (typeof bytes === 'string') return null;
  try {
    const described = Described.safeParse(JSON.parse(bytes.toString('utf8')));
    return described.success ? described.data.description : null;
  } catch {
    return null;
  }
};

const listed = (place: Place): { workflows: WorkflowList['workflows']; findings: Finding[] } => {
  const files = definitionFileNames(place.base, place.folder);
  if (files === 'unreadable') {
    const finding: Finding = { ...notJson(place.shown(place.folder)), severity: 'error' };
    return { workflows: [], findings: [finding] };
  }
  const read = files.map((file) => {
    const path = `${place.folder}/${file}`;
    return { file, path: place.shown(path), bytes: definitionBytes(place.base, path) };
  });
  const workflows = read.map(({ file, path, bytes }) => {
    const description = descriptionOf(bytes);
    return { name: file.slice(0, -'.json'.length), source: place.source, path, description };
  });
  // A file named outside the name form is listed, but no verb takes its name.
  const misnamed = workflows.flatMap(({ name }): Finding[] => {
    const invalid = invalidName([name]);
    return invalid === undefined ? [] : [{ ...invalid, severity: 'warning' }];
  });
  const unreadable = read.flatMap(({ path, bytes }): Finding[] =>
    bytes === 'unreadable' ? [{ ...notJson(path), severity: 'error' }] : [],
  );
  return { workflows, findings: [...misnamed, ...unreadable] };
};

/** The shipped definitions of the located plugin and the project's own; without a usable plugin, the project's alone. */
export const listWorkflows = (request: WorkflowsRequest): Answer<WorkflowList> => {
  const project = projectRoot(request.cwd);
  if (typeof project !== 'string') return stopped([project]);
  const plugin = pluginPlace(request, project);
  const shipped = plugin.place === null ? { workflows: [], findings: [] } : listed(plugin.place);
  const own = listed(projectPlace(project));
  return {
    result: { workflows: [...shipped.workflows, ...own.workflows] },
    findings: [...plugin.findings, ...shipped.findings, ...own.findings],
    refusals: [],
  };
};

/** One definition with its hash, read only. */
export const showWorkflow = (request: WorkflowsRequest, name: string, shipped: boolean): Answer<WorkflowShown> => {
  const invalid = invalidName([name]);
  if (invalid !== undefined) return stopped([invalid]);
  const project = projectRoot(request.cwd);
  if (typeof project !== 'string') return stopped([project]);
  // A project definition needs no plugin, so the plugin is located only for a shipped one.
  const { place, findings } = shipped ? pluginPlace(request, project) : { place: projectPlace(project), findings: [] };
  if (place === null) return stoppedOn(findings);
  const path = `${place.folder}/${name}.json`;
  const bytes = isListed(place.base, path) ? definitionBytes(place.base, path) : 'absent';
  if (bytes === 'absent')
    return stopped([{ code: 'definition.not-found', params: { name, source: place.source } }], findings);
  if (bytes === 'unreadable') return stopped([notJson(place.shown(path))], findings);
  const definition = jsonWithin(bytes.toString('utf8'));
  if (definition === undefined) return stopped([notJson(place.shown(path))], findings);
  const result = { name, source: place.source, path: place.shown(path), hash: sha256(bytes), definition };
  return { result, findings, refusals: [] };
};

// The definitions to validate: those named, each of which its folder must list by that name, else every file of the
// place.
export const chosen = (place: Place, names: readonly string[]): { name: string; path: string }[] | Refusal => {
  const pathOf = (name: string) => `${place.folder}/${name}.json`;
  if (names.length > 0) {
    const missing = names.find((name) => !isListed(place.base, pathOf(name)));
    if (missing !== undefined) return { code: 'definition.not-found', params: { name: missing, source: place.source } };
    return [...new Set(names)].map((name) => ({ name, path: pathOf(name) }));
  }
  const files = definitionFileNames(place.base, place.folder);
  if (files === 'unreadable') return notJson(place.shown(place.folder));
  return files.map((file) => ({ name: file.slice(0, -'.json'.length), path: `${place.folder}/${file}` }));
};

interface Entry {
  name: string;
  path: string;
  /** Undefined when the app refuses the file before the generator runs. */
  bytes: Buffer | undefined;
  refusals: Refusal[];
}

/**
 * The refusal of a project definition named other than its file. The name is read with JSON.parse before any other
 * check of the text, as the doctor reads it, so generate, validate and the doctor give one file the same code. A
 * shipped definition is the plugin's to name, and no project run generates it.
 */
export const mismatchOf = (place: Place, file: string, bytes: Buffer): Refusal | undefined =>
  place.source === 'project' ? nameMismatch(file, jsonOf(bytes.toString('utf8'))) : undefined;

// Each chosen definition with its bytes, or the app's refusal of it; a file removed since the folder was listed is left
// out.
const entriesOf = (place: Place, list: { name: string; path: string }[]): Entry[] =>
  list.flatMap(({ name, path }): Entry[] => {
    const bytes = definitionBytes(place.base, path);
    if (bytes === 'absent') return [];
    const file = place.shown(path);
    if (bytes === 'unreadable') return [{ name, path, bytes: undefined, refusals: [notJson(file)] }];
    const mismatch = mismatchOf(place, file, bytes);
    if (mismatch !== undefined) return [{ name, path, bytes: undefined, refusals: [mismatch] }];
    return [{ name, path, bytes, refusals: [] }];
  });

// One generator run over the chosen readable definitions; each refusal names the file as shown, not the temporary copy.
const checked = (place: Place, root: string, entries: Entry[], env: WorkflowsRequest['env']): Definitions | Refusal => {
  const readable = entries.flatMap(({ bytes }) => (bytes === undefined ? [] : [bytes]));
  const generated =
    readable.length === 0
      ? undefined
      : generate(readable, { root, temp: tmpdir(), timeoutMs: GENERATOR_TIMEOUT_MS, env });
  if (generated !== undefined && 'finding' in generated) {
    return { code: generated.finding.code, params: generated.finding.params };
  }
  const refused = generated !== undefined && 'refusals' in generated ? generated.refusals : [];
  let index = 0;
  return entries.map(({ name, path, bytes, refusals }) => {
    const file = place.shown(path);
    const own: GeneratorRefusal[] = bytes === undefined ? [] : (refused[index++] ?? []);
    return {
      name,
      source: place.source,
      generatorRefusals: own.map(({ field, rule }) => ({ file, field, rule })),
      refusals,
    };
  });
};

/** Validates the named definitions, else all of the source, with the plugin's generator, the format's only validator. */
export const validateWorkflows = (
  request: WorkflowsRequest,
  names: readonly string[],
  shipped: boolean,
): Answer<WorkflowValidation> => {
  const invalid = invalidName(names);
  if (invalid !== undefined) return stopped([invalid]);
  const project = projectRoot(request.cwd);
  if (typeof project !== 'string') return stopped([project]);
  const plugin = pluginPlace(request, project);
  if (plugin.place === null) return stoppedOn(plugin.findings);
  const place = shipped ? plugin.place : projectPlace(project);
  const list = chosen(place, names);
  if (!Array.isArray(list)) return stopped([list], plugin.findings);
  const definitions = checked(place, plugin.place.base, entriesOf(place, list), request.env);
  if (!Array.isArray(definitions)) return stopped([definitions], plugin.findings);
  return { result: { definitions }, findings: plugin.findings, refusals: [] };
};
