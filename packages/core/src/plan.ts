import { z } from 'zod';
import { canonicalHash, type Hasher } from './canonical-json.ts';
import { Finding } from './finding.ts';

/** SHA-256 of a file's bytes or of a canonical JSON value, as 64 lowercase hex digits. */
export const Hash = z.string().regex(/^[0-9a-f]{64}$/);
export type Hash = z.infer<typeof Hash>;

// Project-relative with "/" separators; apply checks the write roots.
const projectPath = z.string().min(1);

// Each kind fixes which side exists: a create has no before, a delete no after. The texts are UTF-8, for the diff.
export const CreateFile = z.strictObject({
  kind: z.literal('create'),
  path: projectPath,
  beforeHash: z.null(),
  afterHash: Hash,
  before: z.null(),
  after: z.string(),
});
export const ReplaceFile = z.strictObject({
  kind: z.literal('replace'),
  path: projectPath,
  beforeHash: Hash,
  afterHash: Hash,
  before: z.string(),
  after: z.string(),
});
export const DeleteFile = z.strictObject({
  kind: z.literal('delete'),
  path: projectPath,
  beforeHash: Hash,
  afterHash: z.null(),
  before: z.string(),
  after: z.null(),
});

export const PlanOperation = z.discriminatedUnion('kind', [CreateFile, ReplaceFile, DeleteFile]);
export type PlanOperation = z.infer<typeof PlanOperation>;

/** A plan as shown before it applies; `skipped` holds the changes left out, such as files the owner edited. */
export const PlanPreview = z.strictObject({
  planHash: Hash,
  operations: z.array(PlanOperation),
  skipped: z.array(Finding),
});
export type PlanPreview = z.infer<typeof PlanPreview>;

/** The plan's identity: the hash of the canonical JSON of each operation's kind, path and hashes, in plan order. */
export const planHash = (
  operations: readonly Pick<PlanOperation, 'kind' | 'path' | 'beforeHash' | 'afterHash'>[],
  hash: Hasher,
): Hash =>
  canonicalHash(
    operations.map(({ kind, path, beforeHash, afterHash }) => ({ kind, path, beforeHash, afterHash })),
    hash,
  );
