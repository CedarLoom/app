import type { Finding } from '@cedarloom/core';

export interface DoctorRequest {
  /** The running Node.js version, as process.versions.node gives it. */
  node: string;
  /** The supported range, as the package's engines.node gives it: ">=" and a major version. */
  required: string;
}

export interface DoctorReport {
  checks: { id: 'node'; status: 'pass' | 'fail' }[];
  plugin: null;
}

/** Checks this installation; the findings carry the details of each failed check. */
export const doctor = ({ node, required }: DoctorRequest): { report: DoctorReport; findings: Finding[] } => {
  const supported = Number(node.split('.')[0]) >= Number(required.replace(/^>=/, ''));
  const findings: Finding[] = supported
    ? []
    : [{ code: 'node.version-unsupported', severity: 'error', params: { found: node, required } }];
  return { report: { checks: [{ id: 'node', status: supported ? 'pass' : 'fail' }], plugin: null }, findings };
};
