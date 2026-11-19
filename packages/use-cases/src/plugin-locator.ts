import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { DoctorReport, Finding } from '@cedarloom/core';
import { z } from 'zod';
import { jsonFile } from './json-file.ts';
import { isContained, reached, realOf, statOf, tooOldFinding } from './plugin-folder.ts';
import { MARKETPLACE, originFinding } from './plugin-origin.ts';
import { projectRoot } from './project-root.ts';

/** The only plugin id whose generator the app runs. */
export const PLUGIN_ID = 'cl-workflow@cedarloom';
const NAME = 'cl-workflow';

type Plugin = NonNullable<DoctorReport['plugin']>;
/** The plugin in use, or null when the findings say why there is none. */
export interface Located {
  plugin: Plugin | null;
  findings: Finding[];
}

export interface LocateRequest {
  pluginsRoot: string;
  cwd: string;
  /** The project root; undefined outside a repository. */
  project: string | undefined;
  /** The --plugin-root folder, absolute; it bypasses the trust rule. */
  override: string | null;
}

const InstalledPlugins = z.looseObject({
  version: z.literal(2),
  plugins: z.record(z.string(), z.unknown()),
});
// A relative path would resolve against whatever folder the app runs in, and no file path holds a NUL.
const AbsolutePath = z.string().refine((path) => isAbsolute(path) && !path.includes('\0'));
const Install = { installPath: AbsolutePath, version: z.string().optional() };
const InstallRecord = z.discriminatedUnion('scope', [
  z.looseObject({ scope: z.literal('local'), projectPath: AbsolutePath, ...Install }),
  z.looseObject({ scope: z.literal('project'), projectPath: AbsolutePath, ...Install }),
  z.looseObject({ scope: z.literal('user'), ...Install }),
  z.looseObject({ scope: z.literal('managed'), ...Install }),
]);
type InstallRecord = z.infer<typeof InstallRecord>;
// Claude Code loads a project's local-scope install first, then its project-scope one, the user's, the managed one.
const SCOPES = ['local', 'project', 'user', 'managed'] as const;

const found = (plugin: Plugin): Finding => ({ code: 'plugin.found', severity: 'info', params: { ...plugin } });
const failed = (finding: Finding): Located => ({ plugin: null, findings: [finding] });
const untrusted = (id: string): Located => failed({ code: 'plugin.untrusted', severity: 'error', params: { id } });

// Claude Code applies a project's record when it names a folder of the same Git working tree; outside one, none applies, nor one whose folder the app cannot reach.
const isForProject = (projectPath: string, project: string | undefined): boolean => {
  const real = realOf(projectPath);
  const root = real === undefined ? undefined : reached(() => projectRoot(real));
  return project !== undefined && root !== undefined && realOf(root) === realOf(project);
};

const isMadeIn = (record: InstallRecord, folder: string | undefined): boolean =>
  (record.scope === 'local' || record.scope === 'project') && realOf(record.projectPath) === folder;

// A version folder that is gone, or marked orphaned (a previous version kept for a while), is no install.
const isUsable = ({ installPath }: InstallRecord): boolean =>
  statOf(installPath)?.isDirectory() === true && !existsSync(join(installPath, '.orphaned_at'));

const recordFor = (records: InstallRecord[], cwd: string, project: string | undefined): InstallRecord | undefined => {
  const applying = records.filter(
    (record) =>
      isUsable(record) &&
      (record.scope === 'user' || record.scope === 'managed' || isForProject(record.projectPath, project)),
  );
  // Within a scope, a record made in cwd itself goes before one made elsewhere in its working tree.
  const here = realOf(cwd);
  const ordered = [...applying.filter((record) => isMadeIn(record, here)), ...applying];
  for (const scope of SCOPES) {
    const record = ordered.find((candidate) => candidate.scope === scope);
    if (record !== undefined) return record;
  }
  return undefined;
};

const overridden = (root: string): Located => {
  const bypassed: Finding = { code: 'plugin.trust-bypassed', severity: 'warning', params: { root } };
  const old = tooOldFinding(root, null);
  if (old !== undefined) return { plugin: null, findings: [bypassed, old] };
  const plugin: Plugin = { id: NAME, version: null, scope: 'override', root };
  return { plugin, findings: [bypassed, found(plugin)] };
};

interface Records {
  /** The record of cl-workflow@cedarloom that applies to the project. */
  record: InstallRecord | undefined;
  /** Other marketplaces' cl-workflow ids with a record that applies to the project. */
  others: string[];
}

// The record of one plugin id that applies to the project, or undefined when its records have an unknown shape.
const applyingOf = (entries: unknown, request: LocateRequest): { record: InstallRecord | undefined } | undefined => {
  const records = z.array(InstallRecord).safeParse(entries);
  return records.success ? { record: recordFor(records.data, request.cwd, request.project) } : undefined;
};

// cl-workflow from any marketplace: the plugin name is what comes before the id's last @.
const isClWorkflow = (id: string): boolean => id.startsWith(NAME) && id.lastIndexOf('@') === NAME.length;

// Another marketplace's records of unknown shape never block the plugin; those of cl-workflow@cedarloom do.
const recordsFor = (request: LocateRequest): Records | { finding: Finding } => {
  const file = join(request.pluginsRoot, 'installed_plugins.json');
  const unknown: Finding = { code: 'plugin.record-unknown', severity: 'error', params: { file } };
  const read = jsonFile(file, InstalledPlugins, unknown);
  if ('finding' in read) return read;
  const plugins = read.value?.plugins ?? {};
  const own = Object.hasOwn(plugins, PLUGIN_ID) ? applyingOf(plugins[PLUGIN_ID], request) : { record: undefined };
  if (own === undefined) return { finding: unknown };
  const others = Object.keys(plugins).filter(
    (id) => id !== PLUGIN_ID && isClWorkflow(id) && applyingOf(plugins[id], request)?.record !== undefined,
  );
  return { record: own.record, others };
};

/** The cl-workflow plugin for the project, located by its install records and refused unless it comes from the CedarLoom marketplace. */
export const locatePlugin = (request: LocateRequest): Located => {
  if (request.override !== null) return overridden(request.override);
  const records = recordsFor(request);
  if ('finding' in records) return failed(records.finding);
  if (records.record !== undefined) return trusted(records.record, request.pluginsRoot);
  const [other] = records.others;
  if (other !== undefined) return untrusted(other);
  return failed({ code: 'plugin.not-found', severity: 'error', params: { pluginsRoot: request.pluginsRoot } });
};

// The located install, once its marketplace, its version folder and the files in it pass the trust rule.
const trusted = (record: InstallRecord, pluginsRoot: string): Located => {
  const origin = originFinding(pluginsRoot);
  if (origin !== undefined) return failed(origin);
  const root = resolve(record.installPath);
  const real = realOf(pluginsRoot);
  // Claude Code caches each version of a marketplace's plugin in its own folder of cache/<marketplace>/<plugin>.
  const cache = real === undefined ? undefined : join(real, 'cache', MARKETPLACE, NAME);
  if (cache === undefined || realOf(dirname(root)) !== cache || !isContained(root)) return untrusted(PLUGIN_ID);
  const version = record.version ?? null;
  const old = tooOldFinding(root, version);
  if (old !== undefined) return failed(old);
  const plugin: Plugin = { id: PLUGIN_ID, version, scope: record.scope, root };
  return { plugin, findings: [found(plugin)] };
};
