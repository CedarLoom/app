import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Code, type CompiledMessage, messageText, type Params, type Refusal } from '@cedarloom/core';
import core from '@cedarloom/core/messages/en.json' with { type: 'json' };
import { projectRoot, type StoreClock } from '@cedarloom/use-cases';
import type { MessagePlaceholders } from './messages/catalog.ts';
import own from './messages/en.json' with { type: 'json' };
import { type Redirect, writeRedirect } from './redirect.ts';
import { buildServer } from './server.ts';
import { portOf, Session, type SessionSource } from './session.ts';

/** What cedarloom-app takes from its process; tests pass their own. */
export interface AppIo extends SessionSource {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** The user's own state folder, which holds the redirect page's folder. */
  stateDir: string;
  /** The store folder of a project root. */
  storeDir: (root: string) => string;
  /** The built UI's folder. */
  uiDir: string;
  clock: StoreClock;
  /** The running Node.js version and the package's engines.node range. */
  node: string;
  required: string;
  /** The package's version, which --version prints. */
  version: string;
  /** Opens a file in its default program: the redirect page in the browser. */
  open: (path: string) => void;
  platform: NodeJS.Platform;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface Options {
  port: number;
  open: boolean;
  pluginRoot: string | null;
  help: boolean;
}

/** A listening server, or the exit code of a start that stopped. */
export type Started = { close: () => Promise<void> } | { exitCode: number };

const BIN = 'cedarloom-app';
const catalog: Readonly<Record<string, CompiledMessage>> = { ...core.messages, ...own.messages };
const text = (id: Code | keyof MessagePlaceholders, params: Params): string => `${messageText(catalog, id, params)}\n`;
const refused = (code: Code, params: Params): { refusal: Refusal } => ({ refusal: { code, params } });

interface Flag {
  name: string;
  rawName: string;
  value: string | undefined;
  inlineValue: boolean | undefined;
}

// A following flag is no value: --port --json is refused, while --port=-1 and --plugin-root=-x carry one.
const valueOf = ({ value, inlineValue }: Flag): string | undefined =>
  value === undefined || (inlineValue !== true && value.startsWith('-')) ? undefined : value;

const portValue = (flag: Flag): number | { refusal: Refusal } => {
  const value = valueOf(flag);
  if (value === undefined) return refused('cli.missing-argument', { argument: '<n>', command: `${BIN} --port` });
  const port = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  // Browsers leave port 80 out of Host and Origin, so the guard would refuse every request.
  return port <= 65_535 && port !== 80 ? port : refused('cli.bad-value', { flag: '--port', value });
};

// A flag this command does not take, or a value on a switch: --no-open=false is refused rather than read as on.
const switchRefusal = ({ name, rawName, value }: Flag): { refusal: Refusal } | undefined => {
  if (name !== 'no-open' && name !== 'json' && name !== 'help')
    return refused('cli.unknown-flag', { flag: rawName, command: BIN });
  return value === undefined ? undefined : refused('cli.bad-value', { flag: rawName, value });
};

// Sets the option a flag names, or returns the usage refusal of the flag.
const applied = (options: Options, flag: Flag, cwd: string): { refusal: Refusal } | undefined => {
  if (flag.name === 'port') {
    const port = portValue(flag);
    if (typeof port !== 'number') return port;
    options.port = port;
    return undefined;
  }
  if (flag.name === 'plugin-root') {
    const dir = valueOf(flag);
    if (!dir) return refused('cli.missing-argument', { argument: '<dir>', command: `${BIN} --plugin-root` });
    options.pluginRoot = resolve(cwd, dir);
    return undefined;
  }
  const refusal = switchRefusal(flag);
  if (refusal === undefined && flag.name === 'no-open') options.open = false;
  if (refusal === undefined && flag.name === 'help') options.help = true;
  return refusal;
};

/** The options of a command line, or the usage refusal of its first wrong word; --json is read before. */
const parse = (argv: readonly string[], cwd: string): Options | { refusal: Refusal } => {
  const options: Options = { port: 0, open: true, pluginRoot: null, help: false };
  const { tokens } = parseArgs({
    args: [...argv],
    strict: false,
    allowPositionals: true,
    tokens: true,
    options: { port: { type: 'string' }, 'plugin-root': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  for (const token of tokens) {
    if (token.kind === 'positional') return refused('cli.unknown-command', { command: token.value, bin: BIN });
    const refusal = token.kind === 'option' ? applied(options, token, cwd) : undefined;
    if (refusal !== undefined) return refusal;
  }
  return options;
};

const message = (error: unknown): string => `${error instanceof Error ? error.message : String(error)}\n`;

/** Opens the redirect page; the URL is printed already, so a failing page or opener is reported and serving goes on. */
export const openPage = (
  io: Pick<AppIo, 'stateDir' | 'open' | 'platform' | 'stderr'>,
  url: string,
  json: boolean,
): Redirect | undefined => {
  let redirect: Redirect | undefined;
  try {
    redirect = writeRedirect(io.stateDir, url);
    io.open(redirect.path);
    // Snap-packaged browsers, a Windows browser under WSL and a Chromebook's Linux container cannot read the page.
    if (io.platform === 'linux' && !json) io.stderr(text('server.open-hint', {}));
  } catch (error) {
    io.stderr(message(error));
  }
  return redirect;
};

// A system error of the bind (it names its syscall), as EADDRINUSE or EACCES, is refused; other errors are bugs.
const bindRefusal = (error: unknown, port: number): Refusal | undefined => {
  if (!(error instanceof Error && 'syscall' in error && 'code' in error)) return undefined;
  if (error.code === 'EADDRINUSE') return { code: 'server.port-in-use', params: { port } };
  return typeof error.code === 'string'
    ? { code: 'server.listen-failed', params: { port, error: error.code } }
    : undefined;
};

type Stop = (refusal: Refusal, exitCode: number) => Started;

// The version, the usage or the usage refusal a command line asks for, or the options to serve with.
const request = (io: AppIo, json: boolean, stop: Stop): Options | Started => {
  if (io.argv.length === 1 && (io.argv[0] === '--version' || io.argv[0] === '-V')) {
    io.stdout(`${io.version}\n`);
    return { exitCode: 0 };
  }
  const options = parse(io.argv, io.cwd);
  if ('refusal' in options) return stop(options.refusal, 2);
  // The document carries no text, so it cannot carry the usage.
  if (options.help && json) return stop({ code: 'cli.flag-conflict', params: { flags: '--help, --json' } }, 2);
  if (!options.help) return options;
  io.stdout(text('help.cedarloom-app', {}));
  return { exitCode: 0 };
};

/** Starts the server for the project in cwd on 127.0.0.1 and prints its URL with the one-time token in the fragment. */
export const start = async (io: AppIo): Promise<Started> => {
  const json = io.argv.includes('--json');
  const stop: Stop = (refusal, exitCode) => {
    if (json) io.stdout(`${JSON.stringify({ result: null, findings: [], refusals: [refusal] })}\n`);
    else io.stderr(text(refusal.code, refusal.params));
    return { exitCode };
  };
  const options = request(io, json, stop);
  if (!('port' in options)) return options;
  const root = projectRoot(io.cwd);
  if (root === undefined) return stop({ code: 'project.not-found', params: { cwd: io.cwd } }, 3);
  let redirect: Redirect | undefined;
  // A page left behind holds a token that is spent or ends with the server, so a failed removal is only reported.
  const removePage = (): void => {
    try {
      redirect?.remove();
    } catch (error) {
      io.stderr(message(error));
    }
  };
  const session = new Session(io, removePage);
  const { node, required, cwd, env, home } = io;
  const doctorInputs = { node, required, cwd, env, home, pluginRoot: options.pluginRoot };
  const project = { root, storeDir: io.storeDir(root), clock: io.clock, ...doctorInputs };
  const app = await buildServer({ session, log: io.stderr, project, ui: io.uiDir });
  try {
    await app.listen({ host: '127.0.0.1', port: options.port });
  } catch (error) {
    await app.close();
    const refusal = bindRefusal(error, options.port);
    if (refusal === undefined) throw error;
    return stop(refusal, 3);
  }
  const port = portOf(app.server);
  const url = `http://127.0.0.1:${port}/#t=${session.token}`;
  io.stdout(json ? `${JSON.stringify({ result: { url, port }, findings: [], refusals: [] })}\n` : `${url}\n`);
  if (options.open) redirect = openPage(io, url, json);
  return {
    close: () => {
      removePage();
      return app.close();
    },
  };
};
