import type { Code, Params } from '@cedarloom/core';
import core from '@cedarloom/core/messages/en.json' with { type: 'json' };
import type { MessagePlaceholders } from './messages/catalog.ts';
import own from './messages/en.json' with { type: 'json' };

// A compiled message as lingui compile writes it: text, and each argument as [name] or [name, format, choices].
type Compiled = string | readonly (string | readonly unknown[])[];
const catalog: Readonly<Record<string, Compiled>> = { ...core.messages, ...own.messages };

/** A value as the terminal shows it: control characters escaped, so a name cannot move the cursor or recolor text. */
export const printable = (value: string): string =>
  value.replace(/\p{Cc}/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

const argument = (id: string, params: Params, name: unknown): string => {
  const value = params[String(name)];
  if (value === undefined) throw new Error(`${id} has no parameter ${String(name)}`);
  if (value === null) return '';
  return printable(Array.isArray(value) ? value.join(', ') : String(value));
};

/** The English text of a code of core/messages or a message of the cli catalog, with its parameters filled in. */
export const message = (id: Code | keyof MessagePlaceholders, params: Params = {}): string => {
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
