import { PROJECT_FOLDER, SHIPPED_FOLDER } from './definition-files.ts';
import { appliedAs, definitionOf, type Generation, generationOf, locatedAfter, start, stoppedBy } from './generate.ts';
import { nameTaken } from './name-taken.ts';
import type { RunStore } from './store.ts';
import { notJson, type WorkflowsRequest } from './workflows.ts';

export interface NewRequest extends WorkflowsRequest {
  /** The project root, absolute. */
  root: string;
  /** The new workflow's name. */
  name: string;
  /** The shipped definition to copy. */
  from: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Plans a new project workflow: the shipped definition `from` copied with its name set to `name`, written to
 * `.cedarloom/workflows/<name>.json` together with its generated files as one plan. A name already used by a project
 * skill, command, workflow or definition is refused. Recovery runs first.
 */
const planNewWorkflow = (store: RunStore, request: NewRequest): Generation => {
  const { root, name, from } = request;
  const { recovered, stop } = start(store, root, [name, from]);
  if (stop !== undefined) return stoppedBy([stop], recovered);
  const taken = nameTaken(request.cwd, root, name);
  if (taken.length > 0) return stoppedBy(taken, recovered);
  const plugin = locatedAfter(recovered, request, root);
  if (!('place' in plugin)) return plugin;
  const { findings } = plugin;
  const shippedPath = `${SHIPPED_FOLDER}/${from}.json`;
  const shipped = definitionOf(plugin.place, { name: from, path: shippedPath });
  if ('code' in shipped) return stoppedBy([shipped], findings);
  const definition: unknown = JSON.parse(shipped.text);
  if (!isObject(definition)) return stoppedBy([notJson(plugin.place.shown(shippedPath))], findings);
  const path = `${PROJECT_FOLDER}/${name}.json`;
  const text = `${JSON.stringify({ ...definition, name }, null, 2)}\n`;
  return generationOf(store, {
    root,
    names: [name],
    env: request.env,
    generator: plugin.place.base,
    definitions: [{ name, path, text }],
    files: new Map([[path, Buffer.from(text)]]),
    findings,
  });
};

/** Creates a project workflow: plans it, and with `yes` applies the plan as a run, crash-ordered. */
export const newWorkflow = (store: RunStore, request: NewRequest, yes: boolean): Generation => {
  const generation = planNewWorkflow(store, request);
  return yes
    ? appliedAs(store, request.root, generation, { action: 'workflow.new', subject: request.name })
    : generation;
};
