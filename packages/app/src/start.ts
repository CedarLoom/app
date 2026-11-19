import { type Code, type CompiledMessage, messageText, type Params, type Refusal } from '@cedarloom/core';
import core from '@cedarloom/core/messages/en.json' with { type: 'json' };
import { projectRoot } from '@cedarloom/use-cases';
import { buildServer } from './server.ts';
import { portOf, Session, type SessionSource } from './session.ts';

/** What cedarloom-app takes from its process; tests pass their own. */
export interface AppIo extends SessionSource {
  argv: readonly string[];
  cwd: string;
  /** Opens the URL in the default browser. */
  open: (url: string) => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface Options {
  port: number;
  open: boolean;
}

/** A listening server, or the exit code of a start that stopped. */
export type Started = { url: string; close: () => Promise<void> } | { exitCode: number };

const BIN = 'cedarloom-app';
const catalog: Readonly<Record<string, CompiledMessage>> = core.messages;
const refused = (code: Code, params: Params): { refusal: Refusal } => ({ refusal: { code, params } });

const portValue = (value: string | undefined): number | { refusal: Refusal } => {
  if (value === undefined) return refused('cli.missing-argument', { argument: '<n>', command: `${BIN} --port` });
  const port = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  return port <= 65_535 ? port : refused('cli.bad-value', { flag: '--port', value });
};

/** The options of a command line, or the usage refusal of its first wrong word; --json is read before. */
const parse = (argv: readonly string[]): Options | { refusal: Refusal } => {
  const options = { port: 0, open: true };
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] ?? '';
    if (word === '--no-open') options.open = false;
    else if (word === '--port') {
      index += 1;
      const port = portValue(argv[index]);
      if (typeof port !== 'number') return port;
      options.port = port;
    } else if (word === '--json') continue;
    else if (word.startsWith('-')) return refused('cli.unknown-flag', { flag: word, command: BIN });
    else return refused('cli.unknown-command', { command: word, bin: BIN });
  }
  return options;
};

const inUse = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';

/** Starts the server for the project in cwd on 127.0.0.1 and prints its URL with the one-time token in the fragment. */
export const start = async (io: AppIo): Promise<Started> => {
  const json = io.argv.includes('--json');
  const stop = (refusal: Refusal, exitCode: number): Started => {
    if (json) io.stdout(`${JSON.stringify({ result: null, findings: [], refusals: [refusal] })}\n`);
    else io.stderr(`${messageText(catalog, refusal.code, refusal.params)}\n`);
    return { exitCode };
  };
  const options = parse(io.argv);
  if ('refusal' in options) return stop(options.refusal, 2);
  if (projectRoot(io.cwd) === undefined) return stop({ code: 'project.not-found', params: { cwd: io.cwd } }, 3);
  const session = new Session(io);
  const app = await buildServer({ session, log: io.stderr });
  try {
    await app.listen({ host: '127.0.0.1', port: options.port });
  } catch (error) {
    await app.close();
    if (inUse(error)) return stop({ code: 'server.port-in-use', params: { port: options.port } }, 3);
    throw error;
  }
  const port = portOf(app.server);
  const url = `http://127.0.0.1:${port}/#t=${session.token}`;
  io.stdout(json ? `${JSON.stringify({ result: { url, port }, findings: [], refusals: [] })}\n` : `${url}\n`);
  if (options.open) io.open(url);
  return { url, close: () => app.close() };
};
