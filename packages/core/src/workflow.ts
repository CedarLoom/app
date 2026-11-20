import { z } from 'zod';
import { JsonValue } from './canonical-json.ts';
import { Refusal } from './finding.ts';
import { Hash } from './plan.ts';

// Device names Windows reserves in every folder, also with an extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
// 255 bytes less 89: the aside `.<name>-run.js.cedarloom-<64-character run id>-<position>.old` at a one-digit position
// (use-cases name-taken.ts, project-files.ts asidePath, apply.ts nameProblem); precheck refuses longer positions.
const LONGEST = 166;

/** A workflow name: it becomes a file and a folder name, so it is checked before it reaches a path. */
export const WorkflowName = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(LONGEST)
  .refine((name) => !RESERVED.test(name));

/** Where a definition comes from: the plugin's own, read only, or the project's in .cedarloom/workflows. */
export const WorkflowSource = z.enum(['shipped', 'project']);
export type WorkflowSource = z.infer<typeof WorkflowSource>;

/** A refusal as the plugin's generator prints it with --json; rule is the plugin's own English text. */
export const GeneratorRefusal = z.strictObject({ file: z.string(), field: z.string(), rule: z.string() });
export type GeneratorRefusal = z.infer<typeof GeneratorRefusal>;

/** The definitions; path is project-relative for a project definition and absolute for a shipped one. */
export const WorkflowList = z.strictObject({
  workflows: z.array(
    z.strictObject({
      name: z.string(),
      source: WorkflowSource,
      path: z.string(),
      /** The file's top-level description, without any format rule applied; null when it has none or does not parse. */
      description: z.string().nullable(),
    }),
  ),
});
export type WorkflowList = z.infer<typeof WorkflowList>;

/** One definition with the hash of its file's bytes. */
export const WorkflowShown = z.strictObject({
  name: z.string(),
  source: WorkflowSource,
  path: z.string(),
  hash: Hash,
  definition: JsonValue,
});
export type WorkflowShown = z.infer<typeof WorkflowShown>;

/** The generator's refusals of each definition, and the app's own codes for one it could not hand to the generator. */
export const WorkflowValidation = z.strictObject({
  definitions: z.array(
    z.strictObject({
      name: z.string(),
      source: WorkflowSource,
      generatorRefusals: z.array(GeneratorRefusal),
      refusals: z.array(Refusal),
    }),
  ),
});
export type WorkflowValidation = z.infer<typeof WorkflowValidation>;
