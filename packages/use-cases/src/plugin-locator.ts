import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { DoctorReport, Finding } from '@cedarloom/core';
import { z } from 'zod';
import { jsonFile } from './json-file.ts';
import { isContained, tooOldFinding } from './plugin-folder.ts';
import { originFinding } from './plugin-origin.ts';

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
  /** The project root; undefined outside a repository, where only the user scope counts. */
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
]);
type InstallRecord = z.infer<typeof InstallRecord>;
// Claude Code loads a project's local-scope install before its project-scope one, and that before the user's.
const SCOPES = ['local', 'project', 'user'] as const;

const found = (plugin: Plugin): Finding => ({ code: 'plugin.found', severity: 'info', params: { ...plugin } });
const failed = (finding: Finding): Located => ({ plugin: null, findings: [finding] });

const isSameFolder = (a: string, b: string): boolean => {
  if (!existsSync(a)) return false;
  return realpathSync(a) === realpathSync(b);
};

// The record that counts for the project, or undefined; a version folder marked orphaned is a previous version kept for a while.
const recordFor = (records: InstallRecord[], project: string | undefined): InstallRecord | undefined => {
  const usable = records.filter(({ installPath }) => !existsSync(join(installPath, '.orphaned_at')));
  for (const scope of SCOPES) {
    const record = usable.find(
      (candidate) =>
        candidate.scope === scope &&
        (candidate.scope === 'user' || (project !== undefined && isSameFolder(candidate.projectPath, project))),
    );
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

// The record that counts for the project per plugin id named cl-workflow, from any marketplace.
const recordsFor = (pluginsRoot: string, project: string | undefined): Map<string, InstallRecord> | Finding => {
  const file = join(pluginsRoot, 'installed_plugins.json');
  const unknown: Finding = { code: 'plugin.record-unknown', severity: 'error', params: { file } };
  const read = jsonFile(file, InstalledPlugins, unknown);
  if ('finding' in read) return read.finding;
  const byId = new Map<string, InstallRecord>();
  for (const [id, entries] of Object.entries(read.value?.plugins ?? {})) {
    const at = id.lastIndexOf('@');
    if (at < 0 || id.slice(0, at) !== NAME) continue;
    const records = z.array(InstallRecord).safeParse(entries);
    if (!records.success) return unknown;
    const record = recordFor(records.data, project);
    if (record !== undefined) byId.set(id, record);
  }
  return byId;
};

/** The cl-workflow plugin for the project, located by its install records and refused unless it comes from the CedarLoom marketplace. */
export const locatePlugin = ({ pluginsRoot, project, override }: LocateRequest): Located => {
  if (override !== null) return overridden(override);
  const byId = recordsFor(pluginsRoot, project);
  if (!(byId instanceof Map)) return failed(byId);
  const record = byId.get(PLUGIN_ID);
  if (record === undefined) {
    const [other] = byId.keys();
    if (other !== undefined) return failed({ code: 'plugin.untrusted', severity: 'error', params: { id: other } });
    return failed({ code: 'plugin.not-found', severity: 'error', params: { pluginsRoot } });
  }
  return trusted(record, pluginsRoot);
};

// The located install, once its marketplace, its version folder and the files in it pass the trust rule.
const trusted = (record: InstallRecord, pluginsRoot: string): Located => {
  const origin = originFinding(pluginsRoot);
  if (origin !== undefined) return failed(origin);
  const root = resolve(record.installPath);
  const version = record.version ?? null;
  const old = tooOldFinding(root, version);
  if (old !== undefined) return failed(old);
  if (!isContained(root)) return failed({ code: 'plugin.untrusted', severity: 'error', params: { id: PLUGIN_ID } });
  const plugin: Plugin = { id: PLUGIN_ID, version, scope: record.scope, root };
  return { plugin, findings: [found(plugin)] };
};
