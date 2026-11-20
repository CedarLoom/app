// Generated from en.po by `pnpm --filter @cedarloom/core run messages`; do not edit.

/**
 * The message ids of namespace core.
 * @public a catalog lists every id, whether its package reads the list or not.
 */
export const MESSAGE_IDS = [
  'api.bad-fields',
  'api.bad-request',
  'api.internal',
  'api.not-found',
  'apply.backup-failed',
  'apply.no-hard-links',
  'apply.recovered',
  'apply.unsettled',
  'apply.write-mismatch',
  'cli.bad-value',
  'cli.confirm-required',
  'cli.flag-conflict',
  'cli.internal',
  'cli.missing-argument',
  'cli.surplus-argument',
  'cli.unknown-command',
  'cli.unknown-flag',
  'cli.value-not-json',
  'definition.invalid',
  'definition.name-mismatch',
  'definition.not-found',
  'definition.not-json',
  'definition.stale',
  'edit.result-over-limits',
  'edit.target-invalid',
  'generate.delete-skipped',
  'generated.file-unreadable',
  'generated.folder-unreadable',
  'generator.failed',
  'generator.output-unknown',
  'node.version-unsupported',
  'plan.file-changed',
  'plan.folder-denied',
  'plan.name-not-portable',
  'plan.name-too-long',
  'plan.not-text',
  'plan.path-nested',
  'plan.path-outside-roots',
  'plan.path-through-file',
  'plan.spelling-clash',
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
  'project.git-unreadable',
  'project.not-found',
  'recovery.skipped',
  'run.already-undone',
  'run.not-found',
  'server.listen-failed',
  'server.open-hint',
  'server.port-in-use',
  'session.cookie',
  'session.csrf',
  'session.host',
  'session.origin',
  'session.token',
  'settings.owner-entry',
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
  'workflow.name-taken',
  'workflow.no-script',
] as const;

/** The ICU arguments of each message, by id: the parameter names of its code. */
export interface MessagePlaceholders {
  'api.bad-fields': 'issues';
  'api.bad-request': never;
  'api.internal': never;
  'api.not-found': never;
  'apply.backup-failed': 'path' | 'run';
  'apply.no-hard-links': 'path';
  'apply.recovered': 'path' | 'run';
  'apply.unsettled': 'path' | 'run';
  'apply.write-mismatch': 'path' | 'run';
  'cli.bad-value': 'flag' | 'value';
  'cli.confirm-required': never;
  'cli.flag-conflict': 'flags';
  'cli.internal': never;
  'cli.missing-argument': 'argument' | 'command';
  'cli.surplus-argument': 'argument' | 'command';
  'cli.unknown-command': 'bin' | 'command';
  'cli.unknown-flag': 'command' | 'flag';
  'cli.value-not-json': 'argument';
  'definition.invalid': 'count' | 'path';
  'definition.name-mismatch': 'file' | 'name';
  'definition.not-found': 'name' | 'source';
  'definition.not-json': 'path';
  'definition.stale': 'name' | 'paths';
  'edit.result-over-limits': never;
  'edit.target-invalid': 'operation' | 'pointer';
  'generate.delete-skipped': 'path';
  'generated.file-unreadable': 'path';
  'generated.folder-unreadable': 'path';
  'generator.failed': 'exitCode' | 'reason' | 'signal' | 'stderr';
  'generator.output-unknown': 'output';
  'node.version-unsupported': 'found' | 'required';
  'plan.file-changed': 'path';
  'plan.folder-denied': 'denied' | 'path';
  'plan.name-not-portable': 'path';
  'plan.name-too-long': 'path';
  'plan.not-text': 'path';
  'plan.path-nested': 'path';
  'plan.path-outside-roots': 'path';
  'plan.path-through-file': 'path';
  'plan.spelling-clash': 'other' | 'path';
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
  'project.git-unreadable': 'path';
  'project.not-found': 'cwd';
  'recovery.skipped': 'path' | 'run';
  'run.already-undone': 'by' | 'run';
  'run.not-found': 'run';
  'server.listen-failed': 'error' | 'port';
  'server.open-hint': never;
  'server.port-in-use': 'port';
  'session.cookie': never;
  'session.csrf': never;
  'session.host': never;
  'session.origin': never;
  'session.token': never;
  'settings.owner-entry': 'kept' | 'key' | 'path';
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
  'workflow.name-taken': 'name' | 'path';
  'workflow.no-script': 'name';
}
