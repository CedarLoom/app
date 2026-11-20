import { parseArgs } from 'node:util';
import type { Refusal } from '@cedarloom/core';

/** The commands by their words; variadic takes its argument any number of times, the others name the flags taken. */
const COMMANDS = {
  doctor: { argument: null, variadic: false, change: false, pluginRoot: true, shipped: false, from: false },
  'runs list': { argument: null, variadic: false, change: false, pluginRoot: false, shipped: false, from: false },
  'runs show': { argument: '<run>', variadic: false, change: false, pluginRoot: false, shipped: false, from: false },
  undo: { argument: '<run>', variadic: false, change: true, pluginRoot: false, shipped: false, from: false },
  'workflows list': { argument: null, variadic: false, change: false, pluginRoot: true, shipped: false, from: false },
  'workflows show': {
    argument: '<name>',
    variadic: false,
    change: false,
    pluginRoot: true,
    shipped: true,
    from: false,
  },
  'workflows validate': {
    argument: '<name>',
    variadic: true,
    change: false,
    pluginRoot: true,
    shipped: true,
    from: false,
  },
  'workflows generate': {
    argument: '<name>',
    variadic: true,
    change: true,
    pluginRoot: true,
    shipped: false,
    from: false,
  },
  'workflows new': { argument: '<name>', variadic: false, change: true, pluginRoot: true, shipped: false, from: true },
  // The switches check their own arguments, as <id> and --plugin rule each other out.
  'workflows off': {
    argument: '<id>',
    variadic: true,
    change: true,
    pluginRoot: true,
    shipped: false,
    from: false,
    flags: ['plugin', 'script-only'],
  },
  'workflows on': {
    argument: '<id>',
    variadic: true,
    change: true,
    pluginRoot: false,
    shipped: false,
    from: false,
    flags: ['plugin'],
  },
} as const;
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
    return isCommand(first) ? { name: first, used: 1 } : usage('cli.unknown-command', { command: first, bin: BIN });
  }
  if (second === undefined) {
    return help ? { topic: first } : usage('cli.missing-argument', { argument: '<verb>', command: `${BIN} ${first}` });
  }
  const name = `${first} ${second}`;
  return isCommand(name) ? { name, used: 2 } : usage('cli.unknown-command', { command: name, bin: BIN });
};

const allowedFlags = (name: CommandName | Noun | null): Set<string> => {
  const allowed = new Set(['json', 'help']);
  if (name === null || isNoun(name)) return allowed;
  if (COMMANDS[name].change) allowed.add('yes');
  if (COMMANDS[name].pluginRoot) allowed.add('plugin-root');
  if (COMMANDS[name].shipped) allowed.add('shipped');
  if (COMMANDS[name].from) allowed.add('from');
  const command = COMMANDS[name];
  if ('flags' in command) for (const flag of command.flags) allowed.add(flag);
  return allowed;
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

const argumentsOf = (name: CommandName, rest: string[]): { args: string[] } | { refusal: Refusal } => {
  const { argument: wanted, variadic } = COMMANDS[name];
  if (variadic) return { args: rest };
  const [argument = null, extra] = rest;
  if (wanted !== null && argument === null)
    return usage('cli.missing-argument', { argument: wanted, command: `${BIN} ${name}` });
  const surplus = wanted === null ? argument : extra;
  if (surplus !== null && surplus !== undefined) return usage('cli.unknown-command', { command: surplus, bin: BIN });
  return { args: argument === null ? [] : [argument] };
};

const isVersion = (argv: readonly string[]): boolean =>
  argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V');

/** Reads a command line of cedarloom or cloom, without the node and bin words. */
export const parse = (argv: readonly string[]): Parsed => {
  if (isVersion(argv)) return { ok: true, value: { kind: 'version' } };
  const line = lineOf(argv);
  const refused = (refusal: Refusal): Parsed => ({ ok: false, refusal, json: line.json });
  const command = commandOf(line.words, line.help);
  if ('refusal' in command) return refused(command.refusal);
  const named = 'name' in command ? command.name : command.topic;
  const stop = flagRefusal(line, named);
  if (stop !== undefined) return refused(stop);
  if (line.help || !('name' in command)) return { ok: true, value: { kind: 'help', topic: named } };
  const taken = argumentsOf(command.name, line.words.slice(command.used));
  if ('refusal' in taken) return refused(taken.refusal);
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
    },
  };
};
