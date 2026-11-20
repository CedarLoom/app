import { isUtf8 } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Finding,
  type GeneratorRefusal,
  JsonValue,
  type PlanOperation,
  type PlanPreview,
  planHash,
  type Refusal,
  type Run,
} from '@cedarloom/core';
import { apply, fileKey, linkRefusal, precheck, refusal } from './apply.ts';
import { Named } from './definition-checks.ts';
import { definitionBytes } from './definition-files.ts';
import { GENERATOR_TIMEOUT_MS, generate, jsonOf } from './generator-run.ts';
import { reached } from './plugin-folder.ts';
import { type Found, readFound, sha256 } from './project-files.ts';
import { recover } from './recover.ts';
import { isOwnPath, withLf } from './stale-paths.ts';
import type { RunStore } from './store.ts';
import { inEffect } from './undo.ts';
import {
  chosen,
  invalidName,
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

interface Definition {
  name: string;
  path: string;
  text: string;
}

const stoppedBy = (refusals: Refusal[], findings: Finding[]): Generation => ({
  plan: null,
  generatorRefusals: [],
  generatedFrom: [],
  run: null,
  refusals,
  findings,
});

// A definition's text; one that is not UTF-8 JSON stops the generation before the generator runs.
const definitionOf = (place: Place, { name, path }: { name: string; path: string }): Definition | Refusal => {
  const bytes = definitionBytes(place.base, path);
  if (bytes === 'absent') return { code: 'definition.not-found', params: { name, source: place.source } };
  if (bytes === 'unreadable' || !isUtf8(bytes)) return notJson(path);
  const text = bytes.toString('utf8');
  // JsonValue also refuses a __proto__ member, as the definition readers do.
  return JsonValue.safeParse(jsonOf(text)).success ? { name, path, text } : notJson(path);
};

// The generator's outputs by their project path; a file that is not UTF-8 is output the app cannot read.
const projectOutputs = (outputs: Map<string, Buffer>): Map<string, Buffer> | Refusal => {
  const binary = [...outputs].find(([, bytes]) => !isUtf8(bytes));
  if (binary !== undefined) return { code: 'generator.output-unknown', params: { output: binary[0] } };
  return new Map([...outputs].map(([path, bytes]) => [`.claude/${path}`, bytes]));
};

// The hash each file had when the newest generation in effect wrote it, for the files below the names the generator
// writes under (all files, for undefined).
const previousFiles = (store: RunStore, names: readonly string[] | undefined): Map<string, string> => {
  const hashes = new Map<string, string | null>();
  for (const generation of store.generations().filter((each) => inEffect(store, each))) {
    for (const { path, afterHash, status } of generation.operations) {
      // A pending or failed step never changed its file.
      if (!hashes.has(path) && (status === 'done' || status === 'settled')) hashes.set(path, afterHash);
    }
  }
  return new Map(
    [...hashes].flatMap(([path, hash]): [string, string][] =>
      hash !== null && (names === undefined || names.some((name) => isOwnPath(path, name))) ? [[path, hash]] : [],
    ),
  );
};

// The names the generator writes the definitions named on the command line under: their name field, which may differ
// from the file name; undefined, for every file, when none was named.
const scopeOf = (names: readonly string[], definitions: Definition[]): string[] | undefined =>
  names.length === 0
    ? undefined
    : definitions.flatMap(({ text }) => {
        const named = Named.safeParse(jsonOf(text));
        return named.success ? [named.data.name] : [];
      });

// The project's file at a planned path; a path outside the write roots, through a link or that the app may not read
// is refused.
const foundAt = (root: string, path: string): Found | Refusal => {
  if (!inWriteRoots(path)) return refusal('plan.path-outside-roots', path);
  return linkRefusal(root, path) ?? reached(() => readFound(join(root, path))) ?? refusal('plan.not-text', path);
};

const isRefusal = (value: Found | Refusal): value is Refusal => typeof value === 'object' && 'code' in value;

// The write that makes the project's file the output; none when it already is, up to line ends.
const write = (root: string, path: string, output: Buffer): PlanOperation | Refusal | undefined => {
  const found = foundAt(root, path);
  if (isRefusal(found)) return found;
  const after = output.toString('utf8');
  const afterHash = sha256(output);
  if (found === 'absent') return { kind: 'create', path, beforeHash: null, afterHash, before: null, after };
  if (found === 'link') return refusal('plan.symlink', path);
  if (found === 'not-file' || !isUtf8(found.bytes)) return refusal('plan.not-text', path);
  if (withLf(found.bytes).equals(withLf(output))) return undefined;
  const before = found.bytes.toString('utf8');
  return { kind: 'replace', path, beforeHash: sha256(found.bytes), afterHash, before, after };
};

// The delete of a file no longer generated, while it is still as last generated; else it is kept and reported.
const remove = (root: string, path: string, hash: string): PlanOperation | Finding | Refusal | undefined => {
  const found = foundAt(root, path);
  if (isRefusal(found)) return found;
  if (found === 'absent') return undefined;
  if (found === 'link') return refusal('plan.symlink', path);
  if (found !== 'not-file' && isUtf8(found.bytes) && [found.bytes, withLf(found.bytes)].map(sha256).includes(hash)) {
    const before = found.bytes.toString('utf8');
    return { kind: 'delete', path, beforeHash: sha256(found.bytes), afterHash: null, before, after: null };
  }
  return { code: 'generate.delete-skipped', severity: 'warning', params: { path } };
};

const inPathOrder = <T>(files: Map<string, T>): [string, T][] => [...files].toSorted(([a], [b]) => (a < b ? -1 : 1));

// The plan from the outputs and the files as last generated, in path order.
const planned = (root: string, outputs: Map<string, Buffer>, previous: Map<string, string>): PlanPreview | Refusal => {
  const kept = new Set([...outputs.keys()].map(fileKey));
  const changes = [
    ...inPathOrder(outputs).map(([path, bytes]) => write(root, path, bytes)),
    ...inPathOrder(previous)
      .filter(([path]) => !kept.has(fileKey(path)))
      .map(([path, hash]) => remove(root, path, hash)),
  ].filter((change) => change !== undefined);
  const stop = changes.find((change): change is Refusal => !('kind' in change) && !('severity' in change));
  if (stop !== undefined) return stop;
  const operations = changes.filter((change) => 'kind' in change).toSorted((a, b) => (a.path < b.path ? -1 : 1));
  const skipped = changes.filter((change): change is Finding => 'severity' in change);
  // A plan apply would refuse is refused before it is shown.
  const unappliable = precheck(root, operations);
  if (unappliable !== undefined) return unappliable;
  return { planHash: planHash(operations, sha256), operations, skipped };
};

/**
 * Plans the generation of the project's definitions into `.claude/`: the plugin's generator writes their outputs into
 * a temporary folder, and the plan creates or replaces each project file that differs and deletes each file the last
 * generation wrote that no output holds any more, while it is unchanged. Recovery runs first.
 */
export const planGeneration = (store: RunStore, request: GenerateRequest): Generation => {
  const invalid = invalidName(request.names);
  if (invalid !== undefined) return stoppedBy([invalid], []);
  const recovered = recover(store, request.root);
  const plugin = pluginPlace(request, request.root);
  if (plugin.place === null) {
    const stop = stoppedOn(plugin.findings);
    return stoppedBy(stop.refusals, [...recovered, ...stop.findings]);
  }
  const findings = [...recovered, ...plugin.findings];
  const place = projectPlace(request.root);
  const list = chosen(place, request.names);
  if (!Array.isArray(list)) return stoppedBy([list], findings);
  const read = list.map((entry) => definitionOf(place, entry));
  const unread = read.find((entry): entry is Refusal => 'code' in entry);
  if (unread !== undefined) return stoppedBy([unread], findings);
  const definitions = read.filter((entry): entry is Definition => 'text' in entry);
  const generatedFrom = definitions.map(({ name, text }) => ({ name, definition: text }));
  const generated =
    definitions.length === 0
      ? { outputs: new Map() }
      : generate(
          definitions.map(({ text }) => Buffer.from(text)),
          { root: plugin.place.base, temp: tmpdir(), timeoutMs: GENERATOR_TIMEOUT_MS, env: request.env },
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
  const plan = planned(request.root, outputs, previousFiles(store, scopeOf(request.names, definitions)));
  if (!('operations' in plan)) return stoppedBy([plan], findings);
  return { plan, generatorRefusals: [], generatedFrom, run: null, refusals: [], findings };
};

/** Generates the project's definitions: plans the generation, and with `yes` applies it as a run, crash-ordered. */
export const generateWorkflows = (store: RunStore, request: GenerateRequest, yes: boolean): Generation => {
  const generation = planGeneration(store, request);
  const { plan, generatedFrom } = generation;
  if (!yes || plan === null || plan.operations.length === 0) return generation;
  const [only] = generatedFrom;
  const applied = apply(store, {
    root: request.root,
    plan,
    run: {
      kind: 'apply',
      action: 'workflow.generate',
      subject: generatedFrom.length === 1 && only !== undefined ? only.name : null,
      undoes: null,
      generatedFrom,
    },
  });
  return {
    ...generation,
    run: applied.run,
    refusals: applied.refusal === null ? [] : [applied.refusal],
    findings: [...generation.findings, ...applied.findings],
  };
};
