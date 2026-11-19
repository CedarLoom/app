import { parseArgs } from 'node:util';
import type { Refusal } from '@cedarloom/core';

/** The commands of this version, by their words; a change is a command that takes --yes; pluginRoot, one that takes --plugin-root. */
const COMMANDS = {
  doctor: { argument: null, change: false, pluginRoot: true },
  'runs list': { argument: null, change: false, pluginRoot: false },
  'runs show': { argument: '<run>', change: false, pluginRoot: false },
  undo: { argument: '<run>', change: true, pluginRoot: false },
} as const;
type CommandName = keyof typeof COMMANDS;
const NOUNS = new Set(['runs']);

/** What the command line asks for: a command with its argument, its usage, or the version. */
export type Request =
  | {
      kind: 'command';
      name: CommandName;
      argument: string | null;
      yes: boolean;
      json: boolean;
      pluginRoot: string | null;
    }
  | { kind: 'help'; topic: CommandName | 'runs' | null }
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
    },
  });
  const words = tokens.flatMap((token) => (token.kind === 'positional' ? [token.value] : []));
  const flags = tokens.flatMap((token) => (token.kind === 'option' ? [token] : []));
  return {
    words,
    flags,
    json: flags.some(({ name }) => name === 'json'),
    help: flags.some(({ name }) => name === 'help'),
  };
};

const isCommand = (words: string): words is CommandName => Object.hasOwn(COMMANDS, words);

// The command the first words name and how many words that took, or with --help a usage topic that names none.
const commandOf = (
  words: string[],
  help: boolean,
): { name: CommandName; used: number } | { topic: 'runs' | null } | { refusal: Refusal } => {
  const [first, second] = words;
  if (first === undefined) {
    return help ? { topic: null } : usage('cli.missing-argument', { argument: '<command>', command: BIN });
  }
  if (!NOUNS.has(first)) {
    return isCommand(first) ? { name: first, used: 1 } : usage('cli.unknown-command', { command: first, bin: BIN });
  }
  if (second === undefined) {
    return help ? { topic: 'runs' } : usage('cli.missing-argument', { argument: '<verb>', command: `${BIN} ${first}` });
  }
  const name = `${first} ${second}`;
  return isCommand(name) ? { name, used: 2 } : usage('cli.unknown-command', { command: name, bin: BIN });
};

const allowedFlags = (name: CommandName | 'runs' | null): Set<string> => {
  const allowed = new Set(['json', 'help']);
  if (name === null || name === 'runs') return allowed;
  if (COMMANDS[name].change) allowed.add('yes');
  if (COMMANDS[name].pluginRoot) allowed.add('plugin-root');
  return allowed;
};

// --plugin-root needs its folder; every other flag is a switch, so --json=false is refused rather than read as on.
const valueRefusal = ({ name, rawName, value }: Flag, command: string): Refusal | undefined => {
  if (name === 'plugin-root')
    return value
      ? undefined
      : { code: 'cli.missing-argument', params: { argument: '<dir>', command: `${command} --plugin-root` } };
  return value === undefined ? undefined : { code: 'cli.bad-value', params: { flag: rawName, value } };
};

// A flag the command does not take, a wrong value, or --help with --json, whose document carries no text.
const flagRefusal = ({ flags, help, json }: Line, name: CommandName | 'runs' | null): Refusal | undefined => {
  const allowed = allowedFlags(name);
  const command = name === null ? BIN : `${BIN} ${name}`;
  for (const flag of flags) {
    if (!allowed.has(flag.name)) return { code: 'cli.unknown-flag', params: { flag: flag.rawName, command } };
    const refusal = valueRefusal(flag, command);
    if (refusal !== undefined) return refusal;
  }
  return help && json ? { code: 'cli.flag-conflict', params: { flags: '--help, --json' } } : undefined;
};

const argumentOf = (name: CommandName, rest: string[]): { argument: string | null } | { refusal: Refusal } => {
  const wanted = COMMANDS[name].argument;
  const [argument = null, extra] = rest;
  if (wanted !== null && argument === null)
    return usage('cli.missing-argument', { argument: wanted, command: `${BIN} ${name}` });
  const surplus = wanted === null ? argument : extra;
  if (surplus !== null && surplus !== undefined) return usage('cli.unknown-command', { command: surplus, bin: BIN });
  return { argument };
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
  const argument = argumentOf(command.name, line.words.slice(command.used));
  if ('refusal' in argument) return refused(argument.refusal);
  const yes = line.flags.some(({ name }) => name === 'yes');
  const pluginRoot = line.flags.findLast(({ name }) => name === 'plugin-root')?.value ?? null;
  return {
    ok: true,
    value: { kind: 'command', name: command.name, argument: argument.argument, yes, json: line.json, pluginRoot },
  };
};
