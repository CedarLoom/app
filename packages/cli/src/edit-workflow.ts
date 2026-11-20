import type { Edit, JsonValue, Refusal } from '@cedarloom/core';
import { editWorkflow, jsonWithin } from '@cedarloom/use-cases';
import { outcomeOf } from './generate.ts';
import type { Io } from './io.ts';
import { withStore } from './locate.ts';
import { type Outcome, refused } from './output.ts';

export type EditVerb = 'add' | 'move' | 'remove' | 'set';

// <value> as JSON, or --unset, which the grammar takes for set alone; set needs one of them.
const valueOf = (value: string | undefined, unset: boolean): { value: JsonValue } | { unset: true } | Refusal => {
  if (value !== undefined && unset) return { code: 'cli.flag-conflict', params: { flags: '<value>, --unset' } };
  if (unset) return { unset };
  if (value === undefined)
    return { code: 'cli.missing-argument', params: { argument: '<value>', command: 'cedarloom workflows set' } };
  const json = jsonWithin(value);
  return json === undefined ? { code: 'cli.value-not-json', params: { argument: '<value>' } } : { value: json };
};

// The edit the verb's arguments after the name ask for.
const editOf = (verb: EditVerb, [first = '', second]: string[], unset: boolean): Edit | Refusal => {
  if (verb === 'move') return { operation: 'move', from: first, to: second ?? '' };
  if (verb === 'remove') return { operation: 'remove', pointer: first };
  const given = valueOf(second, unset);
  if ('code' in given) return given;
  return 'value' in given
    ? { operation: verb, pointer: first, value: given.value }
    : { operation: 'unset', pointer: first };
};

/** cedarloom workflows add, move, remove and set: plans an edit of a project definition with its files, applied with --yes. */
export const workflowsEdit = (
  io: Io,
  {
    verb,
    args: [name = '', ...rest],
    unset,
    pluginRoot,
  }: { verb: EditVerb; args: string[]; unset: boolean; pluginRoot: string | null },
  yes: boolean,
): Outcome => {
  const edit = editOf(verb, rest, unset);
  if ('code' in edit) return refused(edit);
  return withStore(io, (store, root) =>
    outcomeOf(editWorkflow(store, { ...io, pluginRoot, root, name, edit }, yes), yes),
  );
};
