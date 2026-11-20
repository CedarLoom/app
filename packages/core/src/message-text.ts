import type { Params } from './finding.ts';

/** A compiled message as lingui compile writes it: text, and each argument as [name] or [name, format, choices]. */
export type CompiledMessage = string | readonly (string | readonly unknown[])[];

const escaped = (unit: string): string => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`;
/** A value as the terminal shows it: Cc, Cf, Zl and Zp escaped; blanks such as U+00A0, U+3000 and U+3164 pass. */
export const printable = (value: string): string =>
  value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => character.split('').map(escaped).join(''));
/** A multi-line text, such as a stack, with each line printable and its line feeds kept. */
export const printableLines = (text: string): string => text.split('\n').map(printable).join('\n');

// Deeper causes and errors are cut, so a long chain cannot overflow the call stack.
const DEPTH = 100;
const UNREADABLE = '[unreadable]';

// Any code may define what a thrown value holds, a getter or a Proxy trap that throws included.
const tried = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

const tagOf = (value: unknown): string => tried(() => Object.prototype.toString.call(value), UNREADABLE);

// JSON.stringify throws on a cycle, a BigInt or a getter, and gives undefined when toJSON does.
const jsonOf = (value: object): string => tried(() => JSON.stringify(value), undefined) ?? tagOf(value);

// The stack starts with the header "name: message", so a line feed in either would add a line that reads as a frame.
const stackOf = (error: Error): string => {
  const header = tried(() => Error.prototype.toString.call(error), undefined);
  const set = tried(() => error.stack, undefined);
  const stack = typeof set === 'string' ? set : (header ?? tagOf(error));
  if (header !== undefined && !header.includes('\n')) return printableLines(stack);
  if (header !== undefined && stack.startsWith(header))
    return printable(header) + printableLines(stack.slice(header.length));
  return printable(stack);
};

// An error's own lines and the values it wraps, each with its label.
const partsOf = (value: unknown): { own: string[]; inner: [string, unknown][] } => {
  if (!(value instanceof Error))
    return { own: [printable(typeof value === 'object' && value !== null ? jsonOf(value) : String(value))], inner: [] };
  const fields = jsonOf(value);
  const errors = value instanceof AggregateError ? tried(() => value.errors, undefined) : undefined;
  const inner: [string, unknown][] = Array.isArray(errors) ? errors.map((error) => ['[errors]: ', error]) : [];
  if (tried(() => 'cause' in value, false)) inner.unshift(['[cause]: ', tried(() => value.cause, UNREADABLE)]);
  return { own: [stackOf(value), ...(fields === '{}' ? [] : [printable(fields)])], inner };
};

/**
 * A thrown value as a crash report that never throws: each error's stack with its header escaped on its own line, its
 * own fields as JSON, then its cause and an AggregateError's errors, cut after DEPTH levels.
 */
export const printableStack = (thrown: unknown): string => {
  const seen = new Set<unknown>();
  const report = (value: unknown, label: string, depth: number): string[] => {
    if (depth >= DEPTH) return [`${label}[cut: more than ${DEPTH} levels]`];
    if (seen.has(value)) return [`${label}[Circular]`];
    if (tried(() => value instanceof Error, false)) seen.add(value);
    const { own, inner } = tried(() => partsOf(value), { own: [printable(tagOf(value))], inner: [] });
    const [first = '', ...rest] = own;
    return [label + first, ...rest, ...inner.flatMap(([next, wrapped]) => report(wrapped, next, depth + 1))];
  };
  return report(thrown, '', 0).join('\n');
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
