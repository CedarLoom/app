// Generated from en.po by `pnpm --filter @cedarloom/core run messages`; do not edit.

/** The message ids of namespace core: every finding and refusal code. */
export const MESSAGE_IDS = [
  'apply.backup-failed',
  'apply.recovered',
  'apply.write-mismatch',
  'plan.file-changed',
  'plan.name-too-long',
  'plan.not-text',
  'plan.path-outside-roots',
  'plan.symlink',
  'plan.text-mismatch',
  'run.already-undone',
  'run.not-found',
  'store.locked',
  'store.unreadable',
  'store.version-unsupported',
  'undo.backup-changed',
  'undo.backup-missing',
  'undo.file-changed',
  'undo.replaced',
] as const;

/** The ICU arguments of each message, by id: the parameter names of its code. */
export interface MessagePlaceholders {
  'apply.backup-failed': 'path' | 'run';
  'apply.recovered': 'path' | 'run';
  'apply.write-mismatch': 'path' | 'run';
  'plan.file-changed': 'path';
  'plan.name-too-long': 'path';
  'plan.not-text': 'path';
  'plan.path-outside-roots': 'path';
  'plan.symlink': 'path';
  'plan.text-mismatch': 'path';
  'run.already-undone': 'by' | 'run';
  'run.not-found': 'run';
  'store.locked': 'path';
  'store.unreadable': 'path';
  'store.version-unsupported': 'found' | 'supported';
  'undo.backup-changed': 'path';
  'undo.backup-missing': 'path';
  'undo.file-changed': 'path';
  'undo.replaced': 'by' | 'run';
}
