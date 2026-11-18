// Generated from en.po by `pnpm --filter @cedarloom/core run messages`; do not edit.

/** The message ids of namespace core: every finding and refusal code. */
export const MESSAGE_IDS = [
  'apply.backup-failed',
  'apply.write-mismatch',
  'plan.file-changed',
  'plan.not-text',
  'plan.path-outside-roots',
  'plan.symlink',
] as const;

/** The ICU arguments of each message, by id: the parameter names of its code. */
export interface MessagePlaceholders {
  'apply.backup-failed': 'path' | 'run';
  'apply.write-mismatch': 'path' | 'run';
  'plan.file-changed': 'path';
  'plan.not-text': 'path';
  'plan.path-outside-roots': 'path';
  'plan.symlink': 'path';
}
