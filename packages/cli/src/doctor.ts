import { doctor } from '@cedarloom/use-cases';
import type { Io } from './io.ts';
import { columns, type Outcome } from './output.ts';

/** cedarloom doctor: the checks of this installation and the project's plugin. */
export const doctorRun = (io: Io, pluginRoot: string | null): Outcome => {
  const { report, findings } = doctor({ ...io, pluginRoot });
  return { result: report, findings, refusals: [], text: columns(report.checks.map(({ id, status }) => [id, status])) };
};
