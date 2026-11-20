import { z } from 'zod';
import { Finding, Refusal } from './finding.ts';
import { Hash, PlanPreview } from './plan.ts';
import { RunId, RunSummary } from './run.ts';

/** The checks of this installation; the findings carry the details of each failed check. */
export const DoctorReport = z.strictObject({
  checks: z.array(
    z.strictObject({
      id: z.enum(['node', 'project', 'plugin', 'definitions', 'generated']),
      /** skipped: a check this one needs failed, or there is no project to check. */
      status: z.enum(['pass', 'warn', 'fail', 'skipped']),
    }),
  ),
  /** The cl-workflow plugin in use: its install record's version, or the --plugin-root folder as scope override. */
  plugin: z
    .strictObject({
      id: z.string(),
      version: z.string().nullable(),
      scope: z.enum(['local', 'project', 'user', 'managed', 'override']),
      root: z.string(),
    })
    .nullable(),
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
/** A refused or failed apply; run: the run it recorded, whose earlier steps may have written. */
export const ApplyRefusal = Refusal.extend({ run: RunId.optional() });
export type ApplyRefusal = z.infer<typeof ApplyRefusal>;
