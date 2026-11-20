import type { Params } from './finding.ts';

/** A compiled message as lingui compile writes it: text, and each argument as [name] or [name, format, choices]. */
export type CompiledMessage = string | readonly (string | readonly unknown[])[];

const escaped = (unit: string): string => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`;
/**
 * A value as the terminal shows it: control, format, line and paragraph separator characters escaped, so names cannot
 * move the cursor, reorder or hide text, or break lines; blank and filler characters such as U+00A0, U+3000 and U+3164 pass.
 */
export const printable = (value: string): string =>
  value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => character.split('').map(escaped).join(''));
/** A multi-line text, such as a stack, with each line printable and its line feeds kept. */
export const printableLines = (text: string): string => text.split('\n').map(printable).join('\n');

const argument = (id: string, params: Params, name: unknown): string => {
  const value = params[String(name)];
  if (value === undefined) throw new Error(`${id} has no parameter ${String(name)}`);
  if (value === null) return '';
  return printable(Array.isArray(value) ? value.join(', ') : String(value));
};

const ENGLISH_PLURAL = new Intl.PluralRules('en');

// A select argument picks the branch named by its value, "null" for null; a plural argument its exact branch "=n",
// which the compiler keys as "n", else its English plural category, with # in the branch as the number. Both fall back
// to their "other" branch.
const branchOf = (id: string, params: Params, [name, format, choices]: readonly unknown[]): CompiledMessage => {
  const value = params[String(name)];
  if (value === undefined) throw new Error(`${id} has no parameter ${String(name)}`);
  const branches = new Map<string, unknown>(
    typeof choices === 'object' && choices !== null ? Object.entries(choices) : [],
  );
  const keys =
    format === 'plural' && typeof value === 'number'
      ? [String(value), ENGLISH_PLURAL.select(value)]
      : [value === null ? 'null' : String(value)];
  const branch = [...keys, 'other'].map((key) => branches.get(key)).find((found) => found !== undefined);
  if (typeof branch === 'string') return branch;
  if (Array.isArray(branch))
    return format === 'plural' ? branch.map((token) => (token === '#' ? String(value) : token)) : branch;
  throw new Error(`${id} has no branch for ${String(value)}`);
};

const rendered = (id: string, compiled: CompiledMessage, params: Params): string => {
  if (typeof compiled === 'string') return compiled;
  return compiled
    .map((token) => {
      if (typeof token === 'string') return token;
      if (token.length === 1) return argument(id, params, token[0]);
      if (token[1] === 'select' || token[1] === 'plural') return rendered(id, branchOf(id, params, token), params);
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
