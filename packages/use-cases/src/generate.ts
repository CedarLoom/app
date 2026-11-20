import { isUtf8 } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action,
  type Finding,
  type GeneratorRefusal,
  type PlanOperation,
  type PlanPreview,
  planHash,
  type Refusal,
  type Run,
  type SettingsEntry,
} from '@cedarloom/core';
import { apply, fileKey, precheck, refusal, wayRefusal } from './apply.ts';
import { definitionBytes, isListed, jsonWithin } from './definition-files.ts';
import { GENERATOR_TIMEOUT_MS, generate } from './generator-run.ts';
import { reached } from './plugin-folder.ts';
import { type FileFound, fileAt, sha256 } from './project-files.ts';
import { recover, unsettledBy } from './recover.ts';
import { isOwnPath, withLf } from './stale-paths.ts';
import type { RunStore } from './store.ts';
import { inEffect } from './undo.ts';
import {
  chosen,
  invalidName,
  mismatchOf,
  notJson,
  type Place,
  pluginPlace,
  projectPlace,
  stoppedOn,
  type WorkflowsRequest,
} from './workflows.ts';
import { inWriteRoots } from './write-roots.ts';

export interface GenerateRequest extends WorkflowsRequest {
  /** The project root, absolute. */
  root: string;
  /** The project definitions to generate, by name; none for all of them. */
  names: readonly string[];
}

/**
 * A generation's plan; or, with plan null, the generator's refusals of the definitions or the refusals that stop it.
 * `run` is the applied run's id once it is recorded.
 */
export interface Generation {
  plan: PlanPreview | null;
  generatorRefusals: GeneratorRefusal[];
  generatedFrom: Run['generatedFrom'];
  run: string | null;
  refusals: Refusal[];
  findings: Finding[];
}

export interface Definition {
  name: string;
  path: string;
  text: string;
}

export const stoppedBy = (refusals: Refusal[], findings: Finding[]): Generation => ({
  plan: null,
  generatorRefusals: [],
  generatedFrom: [],
  run: null,
  refusals,
  findings,
});

// A definition's text, of a file its folder lists by that name; a project one named other than its file, or one that is
// not UTF-8 JSON, stops the generation before the generator runs.
export const definitionOf = (place: Place, { name, path }: { name: string; path: string }): Definition | Refusal => {
  const bytes = isListed(place.base, path) ? definitionBytes(place.base, path) : 'absent';
  if (bytes === 'absent') return { code: 'definition.not-found', params: { name, source: place.source } };
  const shown = place.shown(path);
  if (bytes === 'unreadable') return notJson(shown);
  const mismatch = mismatchOf(place, shown, bytes);
  if (mismatch !== undefined) return mismatch;
  const text = bytes.toString('utf8');
  return isUtf8(bytes) && jsonWithin(text) !== undefined ? { name, path, text } : notJson(shown);
};

// The generator's outputs by their project path; a file that is not UTF-8 is output the app cannot read.
const projectOutputs = (outputs: Map<string, Buffer>): Map<string, Buffer> | Refusal => {
  const binary = [...outputs].find(([, bytes]) => !isUtf8(bytes));
  if (binary !== undefined) return { code: 'generator.output-unknown', params: { output: binary[0] } };
  return new Map([...outputs].map(([path, bytes]) => [`.claude/${path}`, bytes]));
};

// The hash each file had when the newest generation in effect wrote it, for the files below the names the generator
// writes under (all its files, for none); a definition file a generating run wrote is no output.
const previousFiles = (store: RunStore, names: readonly string[]): Map<string, string> => {
  const hashes = new Map<string, string | null>();
  for (const generation of store.generations().filter((each) => inEffect(store, each))) {
    for (const { path, afterHash, status } of generation.operations) {
      // Only a done or settled step left the file it wrote.
      if (!hashes.has(path) && (status === 'done' || status === 'settled')) hashes.set(path, afterHash);
    }
  }
  return new Map(
    [...hashes].flatMap(([path, hash]): [string, string][] =>
      hash !== null && (names.length === 0 ? path.startsWith('.claude/') : names.some((name) => isOwnPath(path, name)))
        ? [[path, hash]]
        : [],
    ),
  );
};

// The project's file at a planned path; a path outside the write roots, through a link, below a folder the app may not
// enter or below a file, or that the app may not read is refused.
export const foundAt = (root: string, path: string): FileFound | Refusal => {
  if (!inWriteRoots(path)) return refusal('plan.path-outside-roots', path);
  return wayRefusal(root, path) ?? reached(() => fileAt(join(root, path))) ?? refusal('plan.not-text', path);
};

export const isRefusal = (value: FileFound | Refusal): value is Refusal => typeof value === 'object' && 'code' in value;

type ReadHashes = ReadonlyMap<string, string | null>;

// The project's file at a path the caller read, unless it no longer hashes as read (null: read as absent).
const asRead = (root: string, path: string, read: ReadHashes): FileFound | Refusal => {
  const found = foundAt(root, path);
  if (isRefusal(found) || !read.has(path)) return found;
  const now = typeof found === 'object' ? sha256(found.bytes) : found;
  return now === (read.get(path) ?? 'absent') ? found : refusal('plan.file-changed', path);
};

// The write that makes the project's file the output; none when it already is, up to line ends.
const write = (root: string, path: string, output: Buffer, read: ReadHashes): PlanOperation | Refusal | undefined => {
  const found = asRead(root, path, read);
  if (isRefusal(found)) return found;
  const after = output.toString('utf8');
  const afterHash = sha256(output);
  if (found === 'absent') return { kind: 'create', path, beforeHash: null, afterHash, before: null, after };
  if (found === 'link') return refusal('plan.symlink', path);
  if (found === 'not-file' || found === 'too-large' || !isUtf8(found.bytes)) return refusal('plan.not-text', path);
  if (withLf(found.bytes).equals(withLf(output))) return undefined;
  const before = found.bytes.toString('utf8');
  return { kind: 'replace', path, beforeHash: sha256(found.bytes), afterHash, before, after };
};

// The delete of a file no longer generated, while it is still as last generated; else it is kept and reported.
const remove = (
  root: string,
  path: string,
  hash: string,
  read: ReadHashes,
): PlanOperation | Finding | Refusal | undefined => {
  const found = asRead(root, path, read);
  if (isRefusal(found)) return found;
  if (found === 'absent') return undefined;
  if (found === 'link') return refusal('plan.symlink', path);
  if (
    typeof found === 'object' &&
    isUtf8(found.bytes) &&
    [found.bytes, withLf(found.bytes)].map(sha256).includes(hash)
  ) {
    const before = found.bytes.toString('utf8');
    return { kind: 'delete', path, beforeHash: sha256(found.bytes), afterHash: null, before, after: null };
  }
  return { code: 'generate.delete-skipped', severity: 'warning', params: { path } };
};

const inPathOrder = <T>(files: Map<string, T>): [string, T][] => [...files].toSorted(([a], [b]) => (a < b ? -1 : 1));

// The plan from the outputs and the files as last generated, in path order.
const planned = (
  root: string,
  outputs: Map<string, Buffer>,
  previous: Map<string, string>,
  read: ReadHashes,
): PlanPreview | Refusal => {
  const kept = new Set([...outputs.keys()].map(fileKey));
  const changes = [
    ...inPathOrder(outputs).map(([path, bytes]) => write(root, path, bytes, read)),
    ...inPathOrder(previous)
      .filter(([path]) => !kept.has(fileKey(path)))
      .map(([path, hash]) => remove(root, path, hash, read)),
  ].filter((change) => change !== undefined);
  const stop = changes.find((change): change is Refusal => !('kind' in change) && !('severity' in change));
  if (stop !== undefined) return stop;
  const operations = changes.filter((change) => 'kind' in change).toSorted((a, b) => (a.path < b.path ? -1 : 1));
  const skipped = changes.filter((change): change is Finding => 'severity' in change);
  // A plan apply would refuse for its paths or files is refused before it is shown. The hard-link probe stays with apply;
  // the spelling probe writes here only where a volume reads two spellings as two files, and the plan is then refused.
  const unappliable = precheck(root, operations, false);
  if (unappliable !== undefined) return unappliable;
  return { planHash: planHash(operations, sha256), operations, skipped };
};

// A name's refusal before recovery runs; then a run recovery left unsettled stops the change, as apply would refuse its
// plan.
export const start = (
  store: RunStore,
  root: string,
  names: readonly string[],
): { recovered: Finding[]; stop: Refusal | undefined } => {
  const invalid = invalidName(names);
  if (invalid !== undefined) return { recovered: [], stop: invalid };
  const recovered = recover(store, root);
  return { recovered, stop: unsettledBy(recovered) };
};

/** What a generation plans from: the definitions, the plugin root of the generator, and project files to write beside. */
export interface GenerationInputs {
  root: string;
  names: readonly string[];
  env: WorkflowsRequest['env'];
  generator: string;
  definitions: Definition[];
  files: Map<string, Buffer>;
  /** Project files to delete while they hash as given, beside the outputs no longer generated. */
  removed?: Map<string, string>;
  /** The hash of each project file as the caller read it, null where it read none; a file that differs stops the plan. */
  read?: ReadHashes;
  findings: Finding[];
}

/**
 * The plan of generating the definitions with the plugin's generator into a temporary folder, beside the project files
 * given: each output or given file that differs is created or replaced, and each file the last generation for the
 * names wrote that no output holds any more is deleted, while it is unchanged.
 */
export const generationOf = (store: RunStore, inputs: GenerationInputs): Generation => {
  const { root, names, env, generator, definitions, files, removed = new Map(), read = new Map(), findings } = inputs;
  const generatedFrom = definitions.map(({ name, text }) => ({ name, definition: text }));
  const generated =
    definitions.length === 0
      ? { outputs: new Map() }
      : generate(
          definitions.map(({ text }) => Buffer.from(text)),
          { root: generator, temp: tmpdir(), timeoutMs: GENERATOR_TIMEOUT_MS, env },
        );
  if ('finding' in generated)
    return stoppedBy([{ code: generated.finding.code, params: generated.finding.params }], findings);
  if ('refusals' in generated) {
    const generatorRefusals = definitions.flatMap(({ path }, index) =>
      (generated.refusals[index] ?? []).map(({ field, rule }) => ({ file: path, field, rule })),
    );
    return { ...stoppedBy([], findings), generatorRefusals, generatedFrom };
  }
  const outputs = projectOutputs(generated.outputs);
  if (!(outputs instanceof Map)) return stoppedBy([outputs], findings);
  const previous = new Map([...previousFiles(store, names), ...removed]);
  const plan = planned(root, new Map([...outputs, ...files]), previous, read);
  if (!('operations' in plan)) return stoppedBy([plan], findings);
  return { plan, generatorRefusals: [], generatedFrom, run: null, refusals: [], findings };
};

/** The located plugin with the findings so far, recovery's first; without a usable plugin, the generation it stops. */
export const locatedAfter = (
  recovered: Finding[],
  request: WorkflowsRequest,
  root: string,
): { place: Place; findings: Finding[] } | Generation => {
  const plugin = pluginPlace(request, root);
  if (plugin.place !== null) return { place: plugin.place, findings: [...recovered, ...plugin.findings] };
  const stop = stoppedOn(plugin.findings);
  return stoppedBy(stop.refusals, [...recovered, ...stop.findings]);
};

/**
 * Plans the generation of the project's definitions into `.claude/`: the plugin's generator writes their outputs into
 * a temporary folder, and the plan creates or replaces each project file that differs and deletes each file the last
 * generation wrote that no output holds any more, while it is unchanged. Recovery runs first.
 */
export const planGeneration = (store: RunStore, request: GenerateRequest): Generation => {
  const { recovered, stop } = start(store, request.root, request.names);
  if (stop !== undefined) return stoppedBy([stop], recovered);
  const plugin = locatedAfter(recovered, request, request.root);
  if (!('place' in plugin)) return plugin;
  const { findings } = plugin;
  const place = projectPlace(request.root);
  const list = chosen(place, request.names);
  if (!Array.isArray(list)) return stoppedBy([list], findings);
  const read = list.map((entry) => definitionOf(place, entry));
  const unread = read.find((entry): entry is Refusal => 'code' in entry);
  if (unread !== undefined) return stoppedBy([unread], findings);
  const definitions = read.filter((entry): entry is Definition => 'text' in entry);
  const { root, names, env } = request;
  return generationOf(store, {
    root,
    names,
    env,
    generator: plugin.place.base,
    definitions,
    files: new Map(),
    findings,
  });
};

/**
 * Applies a generation's plan as a run, crash-ordered, with the settings entries of its first operation; a generation
 * with nothing to apply is returned as it is.
 */
export const appliedAs = (
  store: RunStore,
  root: string,
  generation: Generation,
  { action, subject, entries }: { action: Exclude<Action, 'undo'>; subject: string | null; entries?: SettingsEntry[] },
): Generation => {
  const { plan, generatedFrom } = generation;
  if (plan === null || plan.operations.length === 0) return generation;
  const run = { kind: 'apply', action, subject, undoes: null, generatedFrom } as const;
  const settings = new Map(entries === undefined ? [] : [[0, entries]]);
  const applied = apply(store, { root, plan, run, earlier: generation.findings, entries: settings });
  return {
    ...generation,
    run: applied.run,
    refusals: applied.refusal === null ? [] : [applied.refusal],
    findings: applied.findings,
  };
};

/** Generates the project's definitions: plans the generation, and with `yes` applies it as a run, crash-ordered. */
export const generateWorkflows = (store: RunStore, request: GenerateRequest, yes: boolean): Generation => {
  const generation = planGeneration(store, request);
  if (!yes) return generation;
  const [only] = generation.generatedFrom;
  const subject = generation.generatedFrom.length === 1 && only !== undefined ? only.name : null;
  return appliedAs(store, request.root, generation, { action: 'workflow.generate', subject });
};
