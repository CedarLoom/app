// Generated from en.po by `pnpm --filter @cedarloom/core run messages`; do not edit.

/**
 * The message ids of namespace core.
 * @public a catalog lists every id, whether its package reads the list or not.
 */
export const MESSAGE_IDS = [
  'api.bad-request',
  'api.internal',
  'api.not-found',
  'apply.backup-failed',
  'apply.recovered',
  'apply.unsettled',
  'apply.write-mismatch',
  'cli.bad-value',
  'cli.confirm-required',
  'cli.flag-conflict',
  'cli.internal',
  'cli.missing-argument',
  'cli.unknown-command',
  'cli.unknown-flag',
  'definition.invalid',
  'definition.not-found',
  'definition.not-json',
  'definition.stale',
  'generate.delete-skipped',
  'generator.failed',
  'generator.output-unknown',
  'node.version-unsupported',
  'plan.file-changed',
  'plan.name-too-long',
  'plan.not-text',
  'plan.path-outside-roots',
  'plan.stale',
  'plan.symlink',
  'plan.text-mismatch',
  'plugin.disabled',
  'plugin.found',
  'plugin.marketplace-untrusted',
  'plugin.not-found',
  'plugin.record-unknown',
  'plugin.too-old',
  'plugin.trust-bypassed',
  'plugin.untrusted',
  'project.not-found',
  'recovery.skipped',
  'run.already-undone',
  'run.not-found',
  'server.open-hint',
  'server.port-in-use',
  'session.cookie',
  'session.csrf',
  'session.host',
  'session.origin',
  'session.token',
  'settings.unreadable',
  'store.locked',
  'store.unreadable',
  'store.version-unsupported',
  'undo.backup-changed',
  'undo.backup-missing',
  'undo.file-changed',
  'undo.replaced',
  'undo.result-kept',
  'workflow.name-invalid',
] as const;

/** The ICU arguments of each message, by id: the parameter names of its code. */
export interface MessagePlaceholders {
  'api.bad-request': 'issues';
  'api.internal': never;
  'api.not-found': never;
  'apply.backup-failed': 'path' | 'run';
  'apply.recovered': 'path' | 'run';
  'apply.unsettled': 'path' | 'run';
  'apply.write-mismatch': 'path' | 'run';
  'cli.bad-value': 'flag' | 'value';
  'cli.confirm-required': never;
  'cli.flag-conflict': 'flags';
  'cli.internal': never;
  'cli.missing-argument': 'argument' | 'command';
  'cli.unknown-command': 'bin' | 'command';
  'cli.unknown-flag': 'command' | 'flag';
  'definition.invalid': 'count' | 'path';
  'definition.not-found': 'name' | 'source';
  'definition.not-json': 'path';
  'definition.stale': 'name' | 'paths';
  'generate.delete-skipped': 'path';
  'generator.failed': 'exitCode' | 'signal' | 'stderr';
  'generator.output-unknown': 'output';
  'node.version-unsupported': 'found' | 'required';
  'plan.file-changed': 'path';
  'plan.name-too-long': 'path';
  'plan.not-text': 'path';
  'plan.path-outside-roots': 'path';
  'plan.stale': never;
  'plan.symlink': 'path';
  'plan.text-mismatch': 'path';
  'plugin.disabled': 'path';
  'plugin.found': 'id' | 'root' | 'scope' | 'version';
  'plugin.marketplace-untrusted': 'marketplace' | 'source';
  'plugin.not-found': 'pluginsRoot';
  'plugin.record-unknown': 'file';
  'plugin.too-old': 'root' | 'version';
  'plugin.trust-bypassed': 'root';
  'plugin.untrusted': 'id';
  'project.not-found': 'cwd';
  'recovery.skipped': 'path' | 'run';
  'run.already-undone': 'by' | 'run';
  'run.not-found': 'run';
  'server.open-hint': never;
  'server.port-in-use': 'port';
  'session.cookie': never;
  'session.csrf': never;
  'session.host': never;
  'session.origin': never;
  'session.token': never;
  'settings.unreadable': 'path';
  'store.locked': 'path';
  'store.unreadable': 'path';
  'store.version-unsupported': 'found' | 'supported';
  'undo.backup-changed': 'path';
  'undo.backup-missing': 'path';
  'undo.file-changed': 'path';
  'undo.replaced': 'by' | 'run';
  'undo.result-kept': 'path' | 'run';
  'workflow.name-invalid': 'name';
}
