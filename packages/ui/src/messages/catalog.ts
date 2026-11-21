// Generated from en.po by `pnpm --filter @cedarloom/ui run messages`; do not edit.

/**
 * The message ids of namespace ui.
 * @public a catalog lists every id, whether its package reads the list or not.
 */
export const MESSAGE_IDS = [
  'ui.column',
  'ui.definitions.empty',
  'ui.doctor.check',
  'ui.doctor.no-plugin',
  'ui.doctor.plugin',
  'ui.doctor.status',
  'ui.findings',
  'ui.loading',
  'ui.run.status',
  'ui.runs.back',
  'ui.runs.empty',
  'ui.title',
  'ui.view',
] as const;

/** The ICU arguments of each message, by id: the parameter names of its code. */
export interface MessagePlaceholders {
  'ui.column': 'column';
  'ui.definitions.empty': never;
  'ui.doctor.check': 'id';
  'ui.doctor.no-plugin': never;
  'ui.doctor.plugin': 'id' | 'root' | 'version';
  'ui.doctor.status': 'status';
  'ui.findings': never;
  'ui.loading': never;
  'ui.run.status': 'status';
  'ui.runs.back': never;
  'ui.runs.empty': never;
  'ui.title': never;
  'ui.view': 'view';
}
