import { isUtf8 } from 'node:buffer';
import {
  type Finding,
  type PlanOperation,
  planHash,
  type Refusal,
  type Run,
  type SettingsEntry,
  type SwitchRecord,
  type SwitchTarget,
  switchedOff,
  switchedOn,
} from '@cedarloom/core';
import { fileKey, precheck, refusal } from './apply.ts';
import {
  appliedAs,
  definitionOf,
  foundAt,
  type Generation,
  isRefusal,
  locatedAfter,
  start,
  stoppedBy,
} from './generate.ts';
import { nestsBeyond } from './json-nesting.ts';
import { PLUGIN_ID } from './plugin-locator.ts';
import { sha256 } from './project-files.ts';
import type { RunStore } from './store.ts';
import { inEffect } from './undo.ts';
import { invalidName, type Place, projectPlace, type WorkflowsRequest } from './workflows.ts';

const SETTINGS = '.claude/settings.json';
const SHIPPED = 'cl-workflow:';
// As deep as the definition readers allow; serializing a deeper value could overflow the stack.
const NESTING_LIMIT = 100;

export interface SwitchOnRequest {
  /** The project root, absolute. */
  root: string;
  /** The workflow id, cl-workflow:<name> for a shipped one; null for the plugin entry. */
  id: string | null;
}

export interface SwitchOffRequest extends WorkflowsRequest, SwitchOnRequest {
  /** Only the Workflow rule. */
  scriptOnly: boolean;
}

interface Switch {
  change: typeof switchedOff;
  target: SwitchTarget;
  findings: Finding[];
  action: 'workflow.off' | 'workflow.on';
  subject: string | null;
}

const unreadable = (): Refusal => ({ code: 'settings.unreadable', params: { path: SETTINGS } });

const nameOf = (id: string): string => (id.startsWith(SHIPPED) ? id.slice(SHIPPED.length) : id);

// As start, with the name's refusal naming the id as typed.
const started = (store: RunStore, root: string, id: string | null): ReturnType<typeof start> =>
  id !== null && invalidName([nameOf(id)]) !== undefined
    ? { recovered: [], stop: { code: 'workflow.name-invalid', params: { name: id } } }
    : start(store, root, []);

// The settings file's bytes and text, null when it does not exist.
const settingsFile = (root: string): { bytes: Buffer; text: string } | null | Refusal => {
  const found = foundAt(root, SETTINGS);
  if (isRefusal(found)) return found;
  if (found === 'absent') return null;
  if (found === 'link') return refusal('plan.symlink', SETTINGS);
  if (found === 'not-file' || !isUtf8(found.bytes) || nestsBeyond(found.bytes, NESTING_LIMIT)) return unreadable();
  return { bytes: found.bytes, text: found.bytes.toString('utf8') };
};

const onSettings = ({ path }: { path: string }): boolean => fileKey(path) === fileKey(SETTINGS);

const entriesOf = (run: Run): SettingsEntry[] => run.operations.flatMap(({ entries }) => entries ?? []);

// A switch run as its record; an undo as the opposite of the record of the run it undid, with the entries as it put
// them back, so each level of undo flips once.
const recordOf = (store: RunStore, run: Run): SwitchRecord => {
  const undid = run.undoes === null ? undefined : store.run(run.undoes);
  if (undid === undefined) return { action: run.action, entries: entriesOf(run) };
  const { action, entries } = recordOf(store, undid);
  return {
    action: action === 'workflow.off' ? 'workflow.on' : 'workflow.off',
    entries: entries.map(({ pointer, value, before }) =>
      before === undefined ? { pointer, value } : { pointer, value: before, before: value },
    ),
  };
};

// Whether an undo down the run's undoneBy chain did not finish, as its write may have taken back what the run wrote.
const undoing = (store: RunStore, run: Run): boolean => {
  const by = run.undoneBy === null ? undefined : store.run(run.undoneBy);
  return store.unfinishedUndos(run.id).length > 0 || (by !== undefined && undoing(store, by));
};

// The first later run on the file planned from the hash, as every planner hashes what it reads; with none, the file now.
const shownAt = (store: RunStore, run: Run, hash: string | null, now: string | null): boolean => {
  const next = store.later(run.id).find(({ operations }) => operations.some(onSettings));
  return (next === undefined ? now : next.operations.find(onSettings)?.beforeHash) === hash;
};

// A record that gives ownership needs a write shown to stand: done or shown at its result, and no undo unfinished.
const written = (store: RunStore, run: Run, now: string | null): boolean => {
  const step = run.operations.find(onSettings);
  if (step === undefined || undoing(store, run)) return false;
  if (run.status === 'done') return true;
  return (step.status === 'failed' || step.status === 'settled') && shownAt(store, run, step.afterHash, now);
};

// The records in effect, newest first; `now` is the hash of the settings file read for the plan, null for none. An off
// record whose write is not shown stays as an on record, which owns nothing and hides older off records of its entries.
const records = (store: RunStore, now: string | null): SwitchRecord[] =>
  store.switches().flatMap((run) => {
    if (!inEffect(store, run)) return [];
    const record = recordOf(store, run);
    return record.action === 'workflow.on' || written(store, run, now)
      ? [record]
      : [{ ...record, action: 'workflow.on' }];
  });

const writeOf = (file: { bytes: Buffer; text: string } | null, after: string): PlanOperation => {
  const afterHash = sha256(Buffer.from(after));
  if (file === null) return { kind: 'create', path: SETTINGS, beforeHash: null, afterHash, before: null, after };
  return { kind: 'replace', path: SETTINGS, beforeHash: sha256(file.bytes), afterHash, before: file.text, after };
};

// The write of the settings file's new text, checked as apply checks it, applied with --yes as one run.
const switchedRun = (store: RunStore, request: { root: string; yes: boolean }, run: Switch): Generation => {
  const { root, yes } = request;
  const { change, target, findings, action, subject } = run;
  const file = settingsFile(root);
  if (file !== null && 'code' in file) return stoppedBy([file], findings);
  const recorded = store.read(() => records(store, file === null ? null : sha256(file.bytes)));
  if (!recorded.ok) return stoppedBy([recorded.refusal], findings);
  const switched = change({ text: file?.text ?? null, path: SETTINGS }, recorded.value, target);
  if (switched === undefined) return stoppedBy([unreadable()], findings);
  const { text, entries, skipped } = switched;
  const operations = text === null ? [] : [writeOf(file, text)];
  const problem = precheck(root, operations);
  if (problem !== undefined) return stoppedBy([problem], findings);
  const plan = { planHash: planHash(operations, sha256), operations, skipped };
  const generation = { ...stoppedBy([], findings), plan };
  return yes ? appliedAs(store, root, generation, { action, subject, entries }) : generation;
};

// Whether the definition has a workflow script; a shipped one is read from the located plugin.
const scriptOf = (
  recovered: Finding[],
  request: SwitchOffRequest,
  id: string,
): { script: boolean; findings: Finding[] } | Generation => {
  const shipped = id.startsWith(SHIPPED);
  const plugin: { place: Place; findings: Finding[] } | Generation = shipped
    ? locatedAfter(recovered, request, request.root)
    : { place: projectPlace(request.root), findings: recovered };
  if (!('place' in plugin)) return plugin;
  const { place, findings } = plugin;
  const name = nameOf(id);
  const definition = definitionOf(place, { name, path: `${place.folder}/${name}.json` });
  if ('code' in definition) return stoppedBy([definition], findings);
  const json: unknown = JSON.parse(definition.text);
  const script = typeof json === 'object' && json !== null && 'script' in json && json.script === true;
  return { script, findings };
};

const rulesOf = (id: string, script: boolean, scriptOnly: boolean): string[] | Refusal => {
  if (scriptOnly && !script) return { code: 'workflow.no-script', params: { name: id } };
  const workflow = `Workflow(${id}-run)`;
  if (scriptOnly) return [workflow];
  return script ? [`Skill(${id})`, workflow] : [`Skill(${id})`];
};

/**
 * Switches off in the project's .claude/settings.json: denies the workflow's skill and, when its definition has a
 * script, its workflow (only the workflow with scriptOnly), or sets the plugin's enabledPlugins entry to false. With
 * `yes` it applies the plan as a run. Recovery runs first.
 */
export const workflowsOff = (store: RunStore, request: SwitchOffRequest, yes: boolean): Generation => {
  const { root, id, scriptOnly } = request;
  const { recovered, stop } = started(store, root, id);
  if (stop !== undefined) return stoppedBy([stop], recovered);
  const run = { change: switchedOff, action: 'workflow.off', subject: id } as const;
  if (id === null)
    return switchedRun(store, { root, yes }, { ...run, target: { plugin: PLUGIN_ID }, findings: recovered });
  const read = scriptOf(recovered, request, id);
  if (!('script' in read)) return read;
  const rules = rulesOf(id, read.script, scriptOnly);
  if (!Array.isArray(rules)) return stoppedBy([rules], read.findings);
  return switchedRun(store, { root, yes }, { ...run, target: { rules }, findings: read.findings });
};

/**
 * Switches back on what the app switched off and still owns in the project's .claude/settings.json: the rules
 * Skill(<id>) and Workflow(<id>-run), or the plugin's enabledPlugins entry. It reads no definition and no plugin. With
 * `yes` it applies the plan as a run. Recovery runs first.
 */
export const workflowsOn = (store: RunStore, { root, id }: SwitchOnRequest, yes: boolean): Generation => {
  const { recovered, stop } = started(store, root, id);
  if (stop !== undefined) return stoppedBy([stop], recovered);
  const target = id === null ? { plugin: PLUGIN_ID } : { rules: [`Skill(${id})`, `Workflow(${id}-run)`] };
  return switchedRun(
    store,
    { root, yes },
    { change: switchedOn, target, findings: recovered, action: 'workflow.on', subject: id },
  );
};
