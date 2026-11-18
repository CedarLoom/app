import { z } from 'zod';
import { JsonValue } from './canonical-json.ts';
import { CreateFile, DeleteFile, Hash, ReplaceFile } from './plan.ts';

/** A run id: file-name safe, and with no leading "-", so a command line never reads it as a flag. */
export const RunId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

// Exactly what Date.prototype.toISOString writes, so stored timestamps sort as text.
const timestamp = z.iso.datetime({ precision: 3 });

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

const summaryShape = {
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
};

// A run is an undo exactly when it names the run it undoes; a running run has no end.
const consistent = (
  run: {
    id: string;
    kind: string;
    action: string;
    status: string;
    endedAt: string | null;
    undoes: string | null;
    undoneBy: string | null;
  },
  context: z.core.$RefinementCtx,
): void => {
  const issue = (path: string, message: string): void => {
    context.addIssue({ code: 'custom', path: [path], message });
  };
  if ((run.kind === 'undo') !== (run.undoes !== null)) issue('undoes', 'undoes is set exactly when kind is undo');
  if ((run.kind === 'undo') !== (run.action === 'undo')) issue('action', 'action is undo exactly when kind is undo');
  if (run.status === 'running' && run.endedAt !== null) issue('endedAt', 'a running run has no end');
  if (run.undoes === run.id || run.undoneBy === run.id) issue('id', 'a run cannot undo itself');
};

export const RunSummary = z.strictObject(summaryShape).superRefine(consistent);
export type RunSummary = z.infer<typeof RunSummary>;

/** A settings entry the run wrote or removed, by a JSON Pointer with no array index; `before`: the value it replaced. */
export const SettingsEntry = z.strictObject({
  pointer: z.string().startsWith('/'),
  value: JsonValue,
  before: z.exactOptional(JsonValue),
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
export const Run = z
  .strictObject({
    ...summaryShape,
    planHash: Hash,
    operations: z.array(RunOperation),
    /** The definition text each generation used, by workflow name. */
    generatedFrom: z.array(z.strictObject({ name: z.string(), definition: z.string() })),
  })
  .superRefine(consistent);
export type Run = z.infer<typeof Run>;
