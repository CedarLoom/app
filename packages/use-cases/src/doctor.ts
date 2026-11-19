import { resolve } from 'node:path';
import type { DoctorReport, Finding } from '@cedarloom/core';
import { enabledFinding } from './plugin-enabled.ts';
import { locatePlugin } from './plugin-locator.ts';
import { type ClaudeDirInputs, claudeConfigDir, pluginsRoot } from './plugins-root.ts';
import { projectRoot } from './project-root.ts';

export interface DoctorRequest extends ClaudeDirInputs {
  /** The running Node.js version, as process.versions.node gives it. */
  node: string;
  /** The supported range, as the package's engines.node gives it: ">=" and a major version. */
  required: string;
  /** The --plugin-root folder, relative to cwd or absolute, or null to locate the installed plugin. */
  pluginRoot: string | null;
}

type Status = DoctorReport['checks'][number]['status'];

const statusOf = (findings: Finding[]): Status => {
  if (findings.some(({ severity }) => severity === 'error')) return 'fail';
  return findings.some(({ severity }) => severity === 'warning') ? 'warn' : 'pass';
};

/** Checks this installation and the project of cwd; the findings carry the details of each failed check. */
export const doctor = (request: DoctorRequest): { report: DoctorReport; findings: Finding[] } => {
  const { node, required, cwd, pluginRoot } = request;
  const supported = Number(node.split('.')[0]) >= Number(required.replace(/^>=/, ''));
  const nodeFindings: Finding[] = supported
    ? []
    : [{ code: 'node.version-unsupported', severity: 'error', params: { found: node, required } }];
  const project = projectRoot(cwd);
  const projectFindings: Finding[] =
    project === undefined ? [{ code: 'project.not-found', severity: 'warning', params: { cwd } }] : [];
  const override = pluginRoot === null ? null : resolve(cwd, pluginRoot);
  const located = locatePlugin({ pluginsRoot: pluginsRoot(request), cwd, project, override });
  // The settings enable the installed plugin, which --plugin-root bypasses.
  const enabled =
    located.plugin === null || override !== null
      ? undefined
      : enabledFinding(project, claudeConfigDir(request), located.plugin.scope === 'managed');
  const pluginFindings = enabled === undefined ? located.findings : [...located.findings, enabled];
  const report: DoctorReport = {
    checks: [
      { id: 'node', status: statusOf(nodeFindings) },
      { id: 'project', status: statusOf(projectFindings) },
      { id: 'plugin', status: statusOf(pluginFindings) },
    ],
    plugin: located.plugin,
  };
  return { report, findings: [...nodeFindings, ...projectFindings, ...pluginFindings] };
};
