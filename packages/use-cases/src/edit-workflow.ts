import { type Edit, edited, JsonValue, type Refusal } from '@cedarloom/core';
import { jsonWithin, Named, PROJECT_FOLDER } from './definition-files.ts';
import { appliedAs, definitionOf, type Generation, generationOf, locatedAfter, start, stoppedBy } from './generate.ts';
import { nameTaken } from './name-taken.ts';
import { sha256 } from './project-files.ts';
import type { RunStore } from './store.ts';
import { invalidName, notJson, projectPlace, type WorkflowsRequest } from './workflows.ts';

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
  if (jsonWithin(text) === undefined) return stoppedBy([notJson(path)], recovered);
  const renamed = next !== name;
  const refusals = renamed ? renameRefusals(request, next) : [];
  if (refusals.length > 0) return stoppedBy(refusals, recovered);
  const plugin = locatedAfter(recovered, request, root);
  if (!('place' in plugin)) return plugin;
  return generationOf(store, {
    root,
    names: renamed ? [name, next] : [name],
    env: request.env,
    generator: plugin.place.base,
    definitions: [{ name: next, path, text }],
    files: new Map([[`${PROJECT_FOLDER}/${next}.json`, Buffer.from(text)]]),
    removed: renamed ? new Map([[path, sha256(Buffer.from(read.text))]]) : new Map(),
    findings: plugin.findings,
  });
};

/** Edits a project workflow: plans the edit, and with `yes` applies the plan as a run, crash-ordered. */
export const editWorkflow = (store: RunStore, request: EditRequest, yes: boolean): Generation => {
  const generation = planEdit(store, request);
  return yes
    ? appliedAs(store, request.root, generation, { action: 'workflow.edit', subject: request.name })
    : generation;
};
