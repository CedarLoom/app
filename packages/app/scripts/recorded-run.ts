import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type PlanOperation, planHash } from '@cedarloom/core';
import { apply, openStore } from '@cedarloom/use-cases';

const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

/** Records a run in a project's store: it created .claude/<file> with the text "notes". */
export const recordRun = (root: string, storeDir: string, id = 'r1', file = 'notes.md'): void => {
  mkdirSync(join(root, '.claude'), { recursive: true });
  const operations: PlanOperation[] = [
    {
      kind: 'create',
      path: `.claude/${file}`,
      beforeHash: null,
      afterHash: sha256('notes'),
      before: null,
      after: 'notes',
    },
  ];
  const store = openStore(storeDir, { now: () => new Date('2026-11-19T06:00:00.000Z'), newRunId: () => id });
  if (!store.ok) throw new Error(store.refusal.code);
  try {
    const plan = { planHash: planHash(operations, sha256), operations, skipped: [] };
    const { refusal } = apply(store.value, {
      root,
      plan,
      run: { kind: 'apply', action: 'workflow.new', subject: 'notes', undoes: null, generatedFrom: [] },
    });
    if (refusal !== null) throw new Error(refusal.code);
  } finally {
    store.value.close();
  }
};
