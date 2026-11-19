import { z } from 'zod';
import { Finding, Refusal } from './finding.ts';
import { Hash, PlanPreview } from './plan.ts';
import { RunSummary } from './run.ts';

/** The checks of this installation; the findings carry the details of each failed check. */
export const DoctorReport = z.strictObject({
  checks: z.array(z.strictObject({ id: z.literal('node'), status: z.enum(['pass', 'fail']) })),
  plugin: z.null(),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

// The bodies of the local server's routes.
export const DoctorResult = DoctorReport.extend({ findings: z.array(Finding) });
export const RunList = z.strictObject({ runs: z.array(RunSummary) });

/** The undo plan of a run, or the undo refusals that stop it; the keys are always present. */
export const UndoPreview = z.strictObject({
  planHash: Hash.nullable(),
  plan: PlanPreview.nullable(),
  refusals: z.array(Refusal),
});

/** The hash of the undo plan the client showed: only that plan applies. */
export const UndoApply = z.strictObject({ planHash: Hash });
export const UndoApplied = z.strictObject({ run: RunSummary });
