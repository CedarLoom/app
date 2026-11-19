import type { Params } from './finding.ts';

/** A compiled message as lingui compile writes it: text, and each argument as [name] or [name, format, choices]. */
export type CompiledMessage = string | readonly (string | readonly unknown[])[];

const escaped = (unit: string): string => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`;
/** A value as the terminal shows it: control, format and separator characters escaped, so names cannot alter the display. */
export const printable = (value: string): string =>
  value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => character.split('').map(escaped).join(''));

const argument = (id: string, params: Params, name: unknown): string => {
  const value = params[String(name)];
  if (value === undefined) throw new Error(`${id} has no parameter ${String(name)}`);
  if (value === null) return '';
  return printable(Array.isArray(value) ? value.join(', ') : String(value));
};

// A select argument picks the branch named by its value, "null" for null, else its "other" branch.
const selected = (id: string, params: Params, [name, , choices]: readonly unknown[]): CompiledMessage => {
  const value = params[String(name)];
  if (value === undefined) throw new Error(`${id} has no parameter ${String(name)}`);
  const branches = new Map<string, unknown>(
    typeof choices === 'object' && choices !== null ? Object.entries(choices) : [],
  );
  const branch = branches.get(value === null ? 'null' : String(value)) ?? branches.get('other');
  if (typeof branch === 'string' || Array.isArray(branch)) return branch;
  throw new Error(`${id} has no branch for ${String(value)}`);
};

const rendered = (id: string, compiled: CompiledMessage, params: Params): string => {
  if (typeof compiled === 'string') return compiled;
  return compiled
    .map((token) => {
      if (typeof token === 'string') return token;
      if (token.length === 1) return argument(id, params, token[0]);
      if (token[1] === 'select') return rendered(id, selected(id, params, token), params);
      throw new Error(`${id} uses a format this renderer does not know`);
    })
    .join('');
};

/** The text of message id in a compiled catalog, with its parameters filled in. */
export const messageText = (
  catalog: Readonly<Record<string, CompiledMessage>>,
  id: string,
  params: Params = {},
): string => {
  const compiled = catalog[id];
  if (compiled === undefined) throw new Error(`no message ${id}`);
  return rendered(id, compiled, params);
};
