import { parseArgs } from 'node:util';
import { type Code, type CompiledMessage, messageText, type Params, type Refusal } from '@cedarloom/core';
import core from '@cedarloom/core/messages/en.json' with { type: 'json' };
import { projectRoot } from '@cedarloom/use-cases';
import { type Redirect, writeRedirect } from './redirect.ts';
import { buildServer } from './server.ts';
import { portOf, Session, type SessionSource } from './session.ts';

/** What cedarloom-app takes from its process; tests pass their own. */
export interface AppIo extends SessionSource {
  argv: readonly string[];
  cwd: string;
  /** The user's own state folder, which holds the redirect page's folder. */
  stateDir: string;
  /** Opens a file in its default program: the redirect page in the browser. */
  open: (path: string) => void;
  platform: NodeJS.Platform;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface Options {
  port: number;
  open: boolean;
}

/** A listening server, or the exit code of a start that stopped. */
export type Started = { close: () => Promise<void> } | { exitCode: number };

const BIN = 'cedarloom-app';
const catalog: Readonly<Record<string, CompiledMessage>> = core.messages;
const refused = (code: Code, params: Params): { refusal: Refusal } => ({ refusal: { code, params } });

const portValue = (value: string | undefined): number | { refusal: Refusal } => {
  if (value === undefined) return refused('cli.missing-argument', { argument: '<n>', command: `${BIN} --port` });
  const port = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  // Browsers leave port 80 out of Host and Origin, so the guard would refuse every request.
  return port <= 65_535 && port !== 80 ? port : refused('cli.bad-value', { flag: '--port', value });
};

interface Flag {
  name: string;
  rawName: string;
  value: string | undefined;
}

// A flag this command does not take, or a value on a switch: --no-open=false is refused rather than read as on.
const switchRefusal = ({ name, rawName, value }: Flag): { refusal: Refusal } | undefined => {
  if (name !== 'no-open' && name !== 'json') return refused('cli.unknown-flag', { flag: rawName, command: BIN });
  return value === undefined ? undefined : refused('cli.bad-value', { flag: rawName, value });
};

/** The options of a command line, or the usage refusal of its first wrong word; --json is read before. */
const parse = (argv: readonly string[]): Options | { refusal: Refusal } => {
  const options = { port: 0, open: true };
  const { tokens } = parseArgs({
    args: [...argv],
    strict: false,
    allowPositionals: true,
    tokens: true,
    options: { port: { type: 'string' } },
  });
  for (const token of tokens) {
    if (token.kind === 'positional') return refused('cli.unknown-command', { command: token.value, bin: BIN });
    if (token.kind === 'option' && token.name === 'port') {
      const port = portValue(token.value);
      if (typeof port !== 'number') return port;
      options.port = port;
    } else if (token.kind === 'option') {
      const refusal = switchRefusal(token);
      if (refusal !== undefined) return refusal;
      if (token.name === 'no-open') options.open = false;
    }
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
    if (io.platform === 'linux' && !json) io.stderr(`${messageText(catalog, 'server.open-hint', {})}\n`);
  } catch (error) {
    io.stderr(message(error));
  }
  return redirect;
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
  if (options.open) redirect = openPage(io, url, json);
  return {
    close: () => {
      removePage();
      return app.close();
    },
  };
};
