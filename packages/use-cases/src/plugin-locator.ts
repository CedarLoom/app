import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { DoctorReport, Finding } from '@cedarloom/core';
import { z } from 'zod';
import { jsonFile } from './json-file.ts';
import { isContained, isInside, tooOldFinding } from './plugin-folder.ts';
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
  plugins: z.record(z.string(), z.array(z.unknown())),
});
// A relative path would resolve against whatever folder the app runs in.
const AbsolutePath = z.string().refine((path) => isAbsolute(path));
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

const realOf = (path: string): string | undefined => (existsSync(path) ? realpathSync.native(path) : undefined);

// Claude Code applies a project's record when it names cwd or a folder of the same Git working tree.
const isForProject = (projectPath: string, cwd: string, project: string | undefined): boolean => {
  const real = realOf(projectPath);
  if (real === undefined) return false;
  if (real === realOf(cwd)) return true;
  const root = projectRoot(real);
  return project !== undefined && root !== undefined && realOf(root) === realOf(project);
};

// A version folder that is gone, or marked orphaned (a previous version kept for a while), is no install.
const isUsable = ({ installPath }: InstallRecord): boolean =>
  statSync(installPath, { throwIfNoEntry: false })?.isDirectory() === true &&
  !existsSync(join(installPath, '.orphaned_at'));

const recordFor = (records: InstallRecord[], cwd: string, project: string | undefined): InstallRecord | undefined => {
  const applying = records.filter(
    (record) =>
      isUsable(record) &&
      (record.scope === 'user' || record.scope === 'managed' || isForProject(record.projectPath, cwd, project)),
  );
  for (const scope of SCOPES) {
    const record = applying.find((candidate) => candidate.scope === scope);
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
  // Claude Code caches a marketplace's plugin versions in cache/<marketplace>/<plugin>; a folder elsewhere does not
  // come from the trusted marketplace.
  if (!isInside(root, join(pluginsRoot, 'cache', MARKETPLACE, NAME))) return untrusted(PLUGIN_ID);
  const version = record.version ?? null;
  const old = tooOldFinding(root, version);
  if (old !== undefined) return failed(old);
  if (!isContained(root)) return untrusted(PLUGIN_ID);
  const plugin: Plugin = { id: PLUGIN_ID, version, scope: record.scope, root };
  return { plugin, findings: [found(plugin)] };
};
