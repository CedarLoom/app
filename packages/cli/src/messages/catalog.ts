// Generated from en.po by `pnpm --filter @cedarloom/cli run messages`; do not edit.

/**
 * The message ids of namespace cli.
 * @public a catalog lists every id, whether its package reads the list or not.
 */
export const MESSAGE_IDS = [
  'help.cedarloom',
  'help.doctor',
  'help.runs',
  'help.runs-list',
  'help.runs-show',
  'help.undo',
  'help.workflows',
  'help.workflows-generate',
  'help.workflows-list',
  'help.workflows-show',
  'help.workflows-validate',
  'output.generate-applied',
  'output.generate-none',
  'output.runs-none',
  'output.undo-applied',
  'output.undo-no-steps',
  'output.workflow-invalid',
  'output.workflow-valid',
  'output.workflows-none',
] as const;

/** The ICU arguments of each message, by id: the parameter names of its code. */
export interface MessagePlaceholders {
  'help.cedarloom': never;
  'help.doctor': never;
  'help.runs': never;
  'help.runs-list': never;
  'help.runs-show': never;
  'help.undo': never;
  'help.workflows': never;
  'help.workflows-generate': never;
  'help.workflows-list': never;
  'help.workflows-show': never;
  'help.workflows-validate': never;
  'output.generate-applied': 'run';
  'output.generate-none': never;
  'output.runs-none': never;
  'output.undo-applied': 'run';
  'output.undo-no-steps': 'run';
  'output.workflow-invalid': 'name' | 'source';
  'output.workflow-valid': 'name' | 'source';
  'output.workflows-none': never;
}
