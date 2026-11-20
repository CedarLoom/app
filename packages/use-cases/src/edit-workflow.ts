import { type Edit, edited, type Finding, JsonValue, type Refusal } from '@cedarloom/core';
import { fileKey } from './apply.ts';
import { jsonWithin, Named, overLimits, PROJECT_FOLDER } from './definition-files.ts';
import { appliedAs, definitionOf, type Generation, generationOf, locatedAfter, start, stoppedBy } from './generate.ts';
import { nameTaken } from './name-taken.ts';
import { sha256 } from './project-files.ts';
import { generatedFiles, isOwnPath } from './stale-paths.ts';
import type { RunStore } from './store.ts';
import { invalidName, projectPlace, type WorkflowsRequest } from './workflows.ts';

export interface EditRequest extends WorkflowsRequest {
  /** The project root, absolute. */
  root: string;
  /** The project workflow to edit. */
  name: string;
  edit: Edit;
}

// The name the edited definition gives; one that is no text is the generator's to refuse, so the file keeps its name.
const nameIn = (definition: JsonValue, name: string): string => Named.safeParse(definition).data?.name ?? name;

// A new name takes the checks of a new workflow's name.
const renameRefusals = (request: EditRequest, next: string): Refusal[] => {
  const invalid = invalidName([next]);
  return invalid === undefined ? nameTaken(request.cwd, request.root, next) : [invalid];
};

// The plan deletes only the old name's files a recorded run wrote; any other generated file of the old name stays.
const withOutputsLeft = (root: string, name: string, generation: Generation): Generation => {
  const { plan, generatedFrom } = generation;
  if (plan === null || generatedFrom.every((each) => each.name === name)) return generation;
  const handled = [...plan.operations.map(({ path }) => path), ...plan.skipped.map(({ params }) => params['path'])];
  const keys = new Set(handled.filter((path) => typeof path === 'string').map(fileKey));
  const { files, unreadable } = generatedFiles(root);
  const paths = [...files.keys()].filter((path) => isOwnPath(path, name) && !keys.has(fileKey(path))).toSorted();
  // A folder or file of the old name the app may not read can hide more of them.
  const hidden = unreadable.filter(
    ({ params: { path } }) => typeof path === 'string' && [path, `${path}/`].some((each) => isOwnPath(each, name)),
  );
  const left: Finding[] =
    paths.length === 0 ? [] : [{ code: 'edit.outputs-left', severity: 'warning', params: { name, paths } }];
  return { ...generation, findings: [...generation.findings, ...left, ...hidden] };
};

/**
 * Plans an edit of a project workflow: the definition with the edit applied, written together with its generated files
 * as one plan. A new name moves the definition file, takes the checks of a new workflow's name, and deletes the outputs
 * the old name's generations wrote. A shipped definition is no project one, so it is not found. Recovery runs first.
 */
const planEdit = (store: RunStore, request: EditRequest): Generation => {
  const { root, name } = request;
  const { recovered, stop } = start(store, root, [name]);
  if (stop !== undefined) return stoppedBy([stop], recovered);
  const path = `${PROJECT_FOLDER}/${name}.json`;
  const read = definitionOf(projectPlace(root), { name, path });
  if ('code' in read) return stoppedBy([read], recovered);
  const result = edited(JsonValue.parse(JSON.parse(read.text)), request.edit);
  if ('refusal' in result) return stoppedBy([result.refusal], recovered);
  const next = nameIn(result.definition, name);
  const text = `${JSON.stringify(result.definition, null, 2)}\n`;
  // The edited definition must read back as the definition readers read it.
  if (jsonWithin(text) === undefined) return stoppedBy([overLimits], recovered);
  const renamed = next !== name;
  const refusals = renamed ? renameRefusals(request, next) : [];
  if (refusals.length > 0) return stoppedBy(refusals, recovered);
  const plugin = locatedAfter(recovered, request, root);
  if (!('place' in plugin)) return plugin;
  const nextPath = `${PROJECT_FOLDER}/${next}.json`;
  const readHash = sha256(Buffer.from(read.text));
  const generation = generationOf(store, {
    root,
    names: renamed ? [name, next] : [name],
    env: request.env,
    generator: plugin.place.base,
    definitions: [{ name: next, path, text }],
    files: new Map([[nextPath, Buffer.from(text)]]),
    removed: renamed ? new Map([[path, readHash]]) : new Map(),
    // A new name's file must be absent; without a rename the later entry, the hash read, holds for the one path.
    read: new Map([
      [nextPath, null],
      [path, readHash],
    ]),
    findings: plugin.findings,
  });
  return withOutputsLeft(root, name, generation);
};

/** Edits a project workflow: plans the edit, and with `yes` applies the plan as a run, crash-ordered. */
export const editWorkflow = (store: RunStore, request: EditRequest, yes: boolean): Generation => {
  const generation = planEdit(store, request);
  return yes
    ? appliedAs(store, request.root, generation, { action: 'workflow.edit', subject: request.name })
    : generation;
};
