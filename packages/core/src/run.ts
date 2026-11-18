import { z } from 'zod';
import { JsonValue } from './canonical-json.ts';
import { CreateFile, DeleteFile, Hash, ReplaceFile } from './plan.ts';

/** A run id: file-name safe, and with no leading "-", so a command line never reads it as a flag. */
export const RunId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

const timestamp = z.iso.datetime();

/** What a run changed for the user. */
export const Action = z.enum([
  'workflow.new',
  'workflow.edit',
  'workflow.generate',
  'workflow.off',
  'workflow.on',
  'undo',
]);
export type Action = z.infer<typeof Action>;

export const RunSummary = z.strictObject({
  id: RunId,
  kind: z.enum(['apply', 'undo']),
  action: Action,
  /** The workflow name or run id the run acted on. */
  subject: z.string().nullable(),
  /** interrupted: the run stopped without an end, and no process holds the store lock. */
  status: z.enum(['running', 'done', 'failed', 'interrupted']),
  startedAt: timestamp,
  endedAt: timestamp.nullable(),
  undoes: RunId.nullable(),
  undoneBy: RunId.nullable(),
});
export type RunSummary = z.infer<typeof RunSummary>;

/** A settings entry the run wrote or removed, by a JSON Pointer with no array index; `before`: the value it replaced. */
export const SettingsEntry = z.strictObject({
  pointer: z.string().startsWith('/'),
  value: JsonValue,
  before: JsonValue.optional(),
});

// An operation as the journal records it: the plan's hashes without the texts, its step status and its settings entries.
const journal = {
  status: z.enum(['pending', 'done', 'failed', 'settled']),
  entries: z.array(SettingsEntry).nullable(),
};
const texts = { before: true, after: true } as const;

export const RunOperation = z.discriminatedUnion('kind', [
  CreateFile.omit(texts).extend(journal),
  ReplaceFile.omit(texts).extend(journal),
  DeleteFile.omit(texts).extend(journal),
]);

/** A run with its journal: every field the store keeps, so the store schema holds all of them from its first version. */
export const Run = RunSummary.extend({
  planHash: Hash,
  operations: z.array(RunOperation),
  /** The definition text each generation used, by workflow name. */
  generatedFrom: z.array(z.strictObject({ name: z.string(), definition: z.string() })),
});
export type Run = z.infer<typeof Run>;
