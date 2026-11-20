import type { Params } from './finding.ts';

/** A compiled message as lingui compile writes it: text, and each argument as [name] or [name, format, choices]. */
export type CompiledMessage = string | readonly (string | readonly unknown[])[];

const escaped = (unit: string): string => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`;
/** A value as the terminal shows it: Cc, Cf, Zl and Zp escaped; blanks such as U+00A0, U+3000 and U+3164 pass. */
export const printable = (value: string): string =>
  value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => character.split('').map(escaped).join(''));
/** A multi-line text, such as a stack, with each line printable and its line feeds kept. */
export const printableLines = (text: string): string => text.split('\n').map(printable).join('\n');

// The stack shows the message after the error's name, so a line feed in the message would add a line that reads as a frame.
const stackOf = (error: Error): string => {
  const { message } = error;
  const stack = typeof error.stack === 'string' ? error.stack : `${error.name}: ${message}`;
  if (!message.includes('\n')) return printableLines(stack);
  const at = stack.lastIndexOf(message);
  if (at === -1) return printable(stack);
  return printable(stack.slice(0, at + message.length)) + printableLines(stack.slice(at + message.length));
};

// JSON.stringify throws on a cycle or a BigInt.
const jsonOf = (value: object): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};

/**
 * A thrown value as a crash report: each error's stack with its message escaped on its own line, its own fields as JSON,
 * then its cause and an AggregateError's errors, to any depth.
 */
export const printableStack = (thrown: unknown): string => {
  const seen = new Set<Error>();
  const report = (value: unknown, label: string): string[] => {
    if (!(value instanceof Error))
      return [label + printable(typeof value === 'object' && value !== null ? jsonOf(value) : String(value))];
    if (seen.has(value)) return [`${label}[Circular]`];
    seen.add(value);
    const fields = jsonOf(value);
    return [
      label + stackOf(value),
      ...(fields === '{}' ? [] : [printable(fields)]),
      ...('cause' in value ? report(value.cause, '[cause]: ') : []),
      ...(value instanceof AggregateError ? value.errors.flatMap((error: unknown) => report(error, '[errors]: ')) : []),
    ];
  };
  return report(thrown, '').join('\n');
};

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
