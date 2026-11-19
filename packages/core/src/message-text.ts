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

/** The text of message id in a compiled catalog, with its parameters filled in. */
export const messageText = (
  catalog: Readonly<Record<string, CompiledMessage>>,
  id: string,
  params: Params = {},
): string => {
  const compiled = catalog[id];
  if (compiled === undefined) throw new Error(`no message ${id}`);
  if (typeof compiled === 'string') return compiled;
  return compiled
    .map((token) => {
      if (typeof token === 'string') return token;
      // Only plain arguments so far; a select or plural message needs its format here first.
      if (token.length > 1) throw new Error(`${id} uses a format this renderer does not know`);
      return argument(id, params, token[0]);
    })
    .join('');
};
