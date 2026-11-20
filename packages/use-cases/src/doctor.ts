import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { DoctorReport, Finding } from '@cedarloom/core';
import { definitionFindings } from './definition-checks.ts';
import { GENERATOR_TIMEOUT_MS } from './generator-run.ts';
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

const SKIPPED_DEFINITIONS = { id: 'definitions', status: 'skipped' } as const;
const SKIPPED_GENERATED = { id: 'generated', status: 'skipped' } as const;

const statusOf = (findings: Finding[]): Status => {
  if (findings.some(({ severity }) => severity === 'error')) return 'fail';
  return findings.some(({ severity }) => severity === 'warning') ? 'warn' : 'pass';
};

// A check that needs one that failed is skipped: the definitions need the project and the plugin's generator, the
// generated files need valid definitions.
const definitionChecks = (
  project: string | undefined,
  plugin: DoctorReport['plugin'],
  pluginStatus: Status,
  env: DoctorRequest['env'],
): { checks: DoctorReport['checks']; findings: Finding[] } => {
  if (project === undefined || plugin === null || pluginStatus === 'fail') {
    return { checks: [SKIPPED_DEFINITIONS, SKIPPED_GENERATED], findings: [] };
  }
  const { root } = plugin;
  const found = definitionFindings({ project, root, temp: tmpdir(), timeoutMs: GENERATOR_TIMEOUT_MS, env });
  const status = statusOf(found.definitions);
  if (status === 'fail')
    return { checks: [{ id: 'definitions', status }, SKIPPED_GENERATED], findings: found.definitions };
  return {
    checks: [
      { id: 'definitions', status },
      { id: 'generated', status: statusOf(found.generated) },
    ],
    findings: [...found.definitions, ...found.generated],
  };
};

/** Checks this installation and the project of cwd; the findings carry the details of each failed check. */
export const doctor = (request: DoctorRequest): { report: DoctorReport; findings: Finding[] } => {
  const { node, required, cwd, pluginRoot } = request;
  const supported = Number(node.split('.')[0]) >= Number(required.replace(/^>=/, ''));
  const nodeFindings: Finding[] = supported
    ? []
    : [{ code: 'node.version-unsupported', severity: 'error', params: { found: node, required } }];
  const root = projectRoot(cwd);
  const project = typeof root === 'string' ? root : undefined;
  const projectFindings: Finding[] = typeof root === 'string' ? [] : [{ ...root, severity: 'warning' }];
  const override = pluginRoot === null ? null : resolve(cwd, pluginRoot);
  const located = locatePlugin({ pluginsRoot: pluginsRoot(request), cwd, project, override });
  // The settings enable the installed plugin, which --plugin-root bypasses.
  const enabled =
    located.plugin === null || override !== null
      ? undefined
      : enabledFinding(project, claudeConfigDir(request), located.plugin.scope === 'managed');
  const pluginFindings = enabled === undefined ? located.findings : [...located.findings, enabled];
  const pluginStatus = statusOf(pluginFindings);
  const definitions = definitionChecks(project, located.plugin, pluginStatus, request.env);
  const report: DoctorReport = {
    checks: [
      { id: 'node', status: statusOf(nodeFindings) },
      { id: 'project', status: statusOf(projectFindings) },
      { id: 'plugin', status: pluginStatus },
      ...definitions.checks,
    ],
    plugin: located.plugin,
  };
  return { report, findings: [...nodeFindings, ...projectFindings, ...pluginFindings, ...definitions.findings] };
};
