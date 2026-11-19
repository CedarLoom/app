import { doctor } from '@cedarloom/use-cases';
import type { Io } from './io.ts';
import { columns, type Outcome } from './output.ts';

/** cedarloom doctor: the checks of this installation. */
export const doctorRun = (io: Io): Outcome => {
  const { report, findings } = doctor({ node: io.node, required: io.required });
  return { result: report, findings, refusals: [], text: columns(report.checks.map(({ id, status }) => [id, status])) };
};
