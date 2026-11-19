import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Code } from '@cedarloom/core';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/** The URL token works once and for this long, so a printed link does not stay valid while the server runs. */
const TOKEN_MS = 10 * 60_000;
const CSRF_HEADER = 'x-cedarloom-csrf';
/** Named per port: browsers send a 127.0.0.1 cookie to every port, so two servers must not take each other's. */
export const cookieName = (port: number): string => `cedarloom_session_${port}`;

/** The port a TCP server is bound to; 0 before it listens. */
export const portOf = (server: { address: () => AddressInfo | string | null }): number => {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
};

// Byte lengths: timingSafeEqual throws on buffers of different lengths, and one character can be several bytes.
const same = (given: unknown, expected: string): boolean => {
  if (typeof given !== 'string') return false;
  const [a, b] = [Buffer.from(given), Buffer.from(expected)];
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Every value of the named cookie in a raw Cookie header, in the order the browser sent them. */
export const cookieValues = (header: string | undefined, name: string): string[] =>
  (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));

/** Where a session takes the time and its 256-bit base64url secrets from; tests pass their own. */
export interface SessionSource {
  now: () => number;
  secret: () => string;
}

interface Grant {
  cookie: string;
  csrf: string;
}

/** One browser session: a URL token exchanged once, before it expires, for a session cookie value and a CSRF value. */
export class Session {
  readonly token: string;
  readonly #source: SessionSource;
  readonly #expires: number;
  #pending: string | null;
  #grant: Grant | null = null;

  constructor(source: SessionSource) {
    this.#source = source;
    this.token = source.secret();
    this.#pending = this.token;
    this.#expires = source.now() + TOKEN_MS;
  }

  /** The cookie value and CSRF value for the URL token, once and before it expires; null otherwise. */
  exchange(token: string): Grant | null {
    if (this.#pending === null || this.#source.now() >= this.#expires || !same(token, this.#pending)) return null;
    this.#pending = null;
    this.#grant = { cookie: this.#source.secret(), csrf: this.#source.secret() };
    return this.#grant;
  }

  /** The grant when the request sent the session's cookie and no other value under its name; null otherwise. */
  grantFor(values: readonly string[]): Grant | null {
    const grant = this.#grant;
    if (grant === null || values.length === 0) return null;
    return values.every((value) => same(value, grant.cookie)) ? grant : null;
  }
}

type Denial = [status: number, code: Code];

// This port's literal 127.0.0.1 Host (421 stops DNS rebinding), its Origin, same-origin: other ports are same-site too.
const foreign = (req: FastifyRequest, self: string): Denial | null => {
  const { host, origin } = req.headers;
  const site = req.headers['sec-fetch-site'];
  if (host !== self) return [421, 'session.host'];
  if (origin !== undefined && origin !== `http://${self}`) return [403, 'session.origin'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return [403, 'session.origin'];
  return null;
};

const SAFE_METHODS = new Set(['GET', 'HEAD']);

// The API by its path and by its matched route, since the router decodes percent-escapes the raw path keeps.
const api = (req: FastifyRequest): boolean =>
  req.url.startsWith('/api/') || (req.routeOptions.url?.startsWith('/api/') ?? false);

const outside = (req: FastifyRequest, session: Session, port: number): Denial | null => {
  if (!api(req) || (req.method === 'POST' && req.routeOptions.url === '/api/session')) return null;
  const grant = session.grantFor(cookieValues(req.headers.cookie, cookieName(port)));
  if (grant === null) return [401, 'session.cookie'];
  if (SAFE_METHODS.has(req.method) || same(req.headers[CSRF_HEADER], grant.csrf)) return null;
  return [403, 'session.csrf'];
};

/** Checks every request, unknown paths too: the Host and Origin rules, then on /api/ the session cookie and the CSRF header. */
export const guard =
  (session: Session) =>
  async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const port = portOf(req.server.server);
    const denial = foreign(req, `127.0.0.1:${port}`) ?? outside(req, session, port);
    return denial === null ? undefined : reply.code(denial[0]).send({ code: denial[1], params: {} });
  };

/** Router errors (a malformed URL) are answered before any hook runs: the Host and Origin rules first, no details. */
export const frameworkErrors = (error: FastifyError, req: FastifyRequest, reply: FastifyReply): void => {
  const [status, code] = foreign(req, `127.0.0.1:${portOf(req.server.server)}`) ?? [
    error.statusCode ?? 400,
    'api.bad-request',
  ];
  // These replies skip the hooks, helmet's too, so they get no-store and nosniff here and no CSP (they hold no page).
  void reply
    .code(status)
    .headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    .send({ code, params: code === 'api.bad-request' ? { issues: [] } : {} });
};
