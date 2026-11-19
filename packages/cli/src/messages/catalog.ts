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
  'output.runs-none',
  'output.undo-applied',
  'output.undo-no-steps',
] as const;

/** The ICU arguments of each message, by id: the parameter names of its code. */
export interface MessagePlaceholders {
  'help.cedarloom': never;
  'help.doctor': never;
  'help.runs': never;
  'help.runs-list': never;
  'help.runs-show': never;
  'help.undo': never;
  'output.runs-none': never;
  'output.undo-applied': 'run';
  'output.undo-no-steps': 'run';
}
