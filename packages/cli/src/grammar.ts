import { parseArgs } from 'node:util';
import type { Refusal } from '@cedarloom/core';

/**
 * A command's arguments in order, the last `optional` of them optional, or with `variadic` its one argument any number
 * of times; and the flags it takes beside --json and --help.
 */
interface Command {
  args: readonly string[];
  optional?: number;
  variadic?: boolean;
  flags: readonly string[];
}
const EDIT = ['yes', 'plugin-root'];

/** The commands by their words. */
const COMMANDS = {
  doctor: { args: [], flags: ['plugin-root'] },
  'runs list': { args: [], flags: [] },
  'runs show': { args: ['<run>'], flags: [] },
  undo: { args: ['<run>'], flags: ['yes'] },
  'workflows list': { args: [], flags: ['plugin-root'] },
  'workflows show': { args: ['<name>'], flags: ['plugin-root', 'shipped'] },
  'workflows validate': { args: ['<name>'], variadic: true, flags: ['plugin-root', 'shipped'] },
  'workflows generate': { args: ['<name>'], variadic: true, flags: ['yes', 'plugin-root'] },
  'workflows new': { args: ['<name>'], flags: ['yes', 'plugin-root', 'from'] },
  'workflows add': { args: ['<name>', '<pointer>', '<value>'], flags: EDIT },
  'workflows move': { args: ['<name>', '<from>', '<to>'], flags: EDIT },
  'workflows remove': { args: ['<name>', '<pointer>'], flags: EDIT },
  // set takes <value> or --unset; which one is the command's own check.
  'workflows set': { args: ['<name>', '<pointer>', '<value>'], optional: 1, flags: [...EDIT, 'unset'] },
  // The switches take <id> or --plugin; which one is the command's own check.
  'workflows off': { args: ['<id>'], optional: 1, flags: [...EDIT, 'plugin', 'script-only'] },
  'workflows on': { args: ['<id>'], optional: 1, flags: ['yes', 'plugin'] },
} satisfies Record<string, Command>;
type CommandName = keyof typeof COMMANDS;
const NOUNS = ['runs', 'workflows'] as const;
type Noun = (typeof NOUNS)[number];

/** What the command line asks for: a command with its argument, its usage, or the version. */
export type Request =
  | {
      kind: 'command';
      name: CommandName;
      args: string[];
      yes: boolean;
      shipped: boolean;
      json: boolean;
      pluginRoot: string | null;
      from: string | null;
      plugin: boolean;
      scriptOnly: boolean;
      unset: boolean;
    }
  | { kind: 'help'; topic: CommandName | Noun | null }
  | { kind: 'version' };
export type Parsed = { ok: true; value: Request } | { ok: false; refusal: Refusal; json: boolean };

/** The fixed name every message gives; cloom reports as cedarloom too, since how a process was started varies. */
const BIN = 'cedarloom';

interface Flag {
  name: string;
  rawName: string;
  value: string | undefined;
  inlineValue: boolean | undefined;
}
interface Line {
  words: string[];
  flags: Flag[];
  json: boolean;
  help: boolean;
}

const usage = (code: Refusal['code'], params: Refusal['params']): { refusal: Refusal } => ({
  refusal: { code, params },
});

const lineOf = (argv: readonly string[]): Line => {
  const { tokens } = parseArgs({
    args: [...argv],
    strict: false,
    allowPositionals: true,
    tokens: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
      'plugin-root': { type: 'string' },
      from: { type: 'string' },
    },
  });
  const words = tokens.flatMap((token) => (token.kind === 'positional' ? [token.value] : []));
  const flags = tokens.flatMap((token) => (token.kind === 'option' ? [token] : []));
  return {
    words,
    flags,
    // --plugin-root takes a following --json as its folder, which is refused; the document is still asked for.
    json: flags.some(({ name, value, inlineValue }) => name === 'json' || (!inlineValue && value === '--json')),
    help: flags.some(({ name }) => name === 'help'),
  };
};

const isCommand = (words: string): words is CommandName => Object.hasOwn(COMMANDS, words);
const commandNamed = (name: CommandName): Command => COMMANDS[name];
const isNoun = (word: string): word is Noun => (NOUNS as readonly string[]).includes(word);

// The command the first words name and how many words that took, or with --help a usage topic that names none.
const commandOf = (
  words: string[],
  help: boolean,
): { name: CommandName; used: number } | { topic: Noun | null } | { refusal: Refusal } => {
  const [first, second] = words;
  if (first === undefined) {
    return help ? { topic: null } : usage('cli.missing-argument', { argument: '<command>', command: BIN });
  }
  if (!isNoun(first)) {
    // A quoted "runs list" is one word, not the noun and verb.
    return isCommand(first) && !first.includes(' ')
      ? { name: first, used: 1 }
      : usage('cli.unknown-command', { command: first, bin: BIN });
  }
  if (second === undefined) {
    return help ? { topic: first } : usage('cli.missing-argument', { argument: '<verb>', command: `${BIN} ${first}` });
  }
  const name = `${first} ${second}`;
  return isCommand(name) ? { name, used: 2 } : usage('cli.unknown-command', { command: name, bin: BIN });
};

const allowedFlags = (name: CommandName | Noun | null): Set<string> => {
  const shared = ['json', 'help'];
  return new Set(name === null || isNoun(name) ? shared : [...shared, ...commandNamed(name).flags]);
};

const VALUES = new Map([
  ['plugin-root', '<dir>'],
  ['from', '<shipped>'],
]);

// --plugin-root and --from need a value, never a following flag (--plugin-root=-x names one); other flags refuse one.
const valueRefusal = ({ name, rawName, value, inlineValue }: Flag, command: string): Refusal | undefined => {
  const argument = VALUES.get(name);
  if (argument !== undefined)
    return value && (inlineValue === true || !value.startsWith('-'))
      ? undefined
      : { code: 'cli.missing-argument', params: { argument, command: `${command} --${name}` } };
  return value === undefined ? undefined : { code: 'cli.bad-value', params: { flag: rawName, value } };
};

// A flag the command does not take, a wrong value, or --help with --json, whose document carries no text.
const flagRefusal = ({ flags, help, json }: Line, name: CommandName | Noun | null): Refusal | undefined => {
  const allowed = allowedFlags(name);
  const command = name === null ? BIN : `${BIN} ${name}`;
  for (const flag of flags) {
    if (!allowed.has(flag.name)) return { code: 'cli.unknown-flag', params: { flag: flag.rawName, command } };
    const refusal = valueRefusal(flag, command);
    if (refusal !== undefined) return refusal;
  }
  return help && json ? { code: 'cli.flag-conflict', params: { flags: '--help, --json' } } : undefined;
};

// A surplus word is refused also with --help; a missing argument only without it, since the usage then names it.
const argumentsOf = (name: CommandName, rest: string[], help: boolean): { args: string[] } | { refusal: Refusal } => {
  const { args, optional = 0, variadic } = commandNamed(name);
  if (variadic) return { args: rest };
  const command = `${BIN} ${name}`;
  const surplus = rest[args.length];
  if (surplus !== undefined) return usage('cli.surplus-argument', { argument: surplus, command });
  // An empty <run> names no run.
  const given = (argument: string, index: number): boolean =>
    rest[index] !== undefined && !(argument === '<run>' && rest[index] === '');
  const missing = args.find((argument, index) => index < args.length - optional && !given(argument, index));
  if (!help && missing !== undefined) return usage('cli.missing-argument', { argument: missing, command });
  return { args: rest };
};

const isVersion = (argv: readonly string[]): boolean =>
  argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V');

// --version or -V beside another flag and no word; with a word, the command's own flags decide.
const versionConflict = ({ words, flags }: Line): Refusal | undefined => {
  const version = flags.find(({ name }) => name === 'version');
  const other = flags.find(({ name }) => name !== 'version');
  if (words.length > 0 || version === undefined || other === undefined) return undefined;
  return { code: 'cli.flag-conflict', params: { flags: `${version.rawName}, ${other.rawName}` } };
};

/** Reads a command line of cedarloom or cloom, without the node and bin words. */
export const parse = (argv: readonly string[]): Parsed => {
  if (isVersion(argv)) return { ok: true, value: { kind: 'version' } };
  const line = lineOf(argv);
  const refused = (refusal: Refusal): Parsed => ({ ok: false, refusal, json: line.json });
  const conflict = versionConflict(line);
  if (conflict !== undefined) return refused(conflict);
  const command = commandOf(line.words, line.help);
  if ('refusal' in command) return refused(command.refusal);
  const named = 'name' in command ? command.name : command.topic;
  const stop = flagRefusal(line, named);
  if (stop !== undefined) return refused(stop);
  if (!('name' in command)) return { ok: true, value: { kind: 'help', topic: named } };
  const taken = argumentsOf(command.name, line.words.slice(command.used), line.help);
  if ('refusal' in taken) return refused(taken.refusal);
  if (line.help) return { ok: true, value: { kind: 'help', topic: command.name } };
  const has = (flag: string): boolean => line.flags.some(({ name }) => name === flag);
  const valueOf = (flag: string): string | null => line.flags.findLast(({ name }) => name === flag)?.value ?? null;
  return {
    ok: true,
    value: {
      kind: 'command',
      name: command.name,
      args: taken.args,
      yes: has('yes'),
      shipped: has('shipped'),
      json: line.json,
      pluginRoot: valueOf('plugin-root'),
      from: valueOf('from'),
      plugin: has('plugin'),
      scriptOnly: has('script-only'),
      unset: has('unset'),
    },
  };
};
