import helmet from '@fastify/helmet';
import type { Code, Params } from '@cedarloom/core';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cookieName, cookieValues, frameworkErrors, guard, portOf, type Session } from './session.ts';

export interface ServerOptions {
  session: Session;
  /** Where errors the client does not see go: the server's terminal. */
  log: (text: string) => void;
}

const refusal = (code: Code, params: Params = {}): { code: Code; params: Params } => ({ code, params });
const badRequest = (issues: string[]): ReturnType<typeof refusal> => refusal('api.bad-request', { issues });

// Fastify's client errors (body over bodyLimit 413, wrong content type 415, malformed JSON 400) keep their status.
const errors = (app: FastifyInstance, log: (text: string) => void): void => {
  app.setErrorHandler((error: FastifyError, _req, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) return reply.code(status).send(badRequest([]));
    log(`${error.stack ?? String(error)}\n`);
    return reply.code(500).send(refusal('api.internal'));
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(refusal('api.not-found')));
};

const Exchange = z.strictObject({ token: z.string() });

/** POST exchanges the URL token for the cookie and the CSRF value; GET gives the CSRF value again for the cookie. */
const sessionRoutes = (app: FastifyInstance, session: Session): void => {
  app.post('/api/session', async (req, reply) => {
    const body = Exchange.safeParse(req.body);
    if (!body.success) return reply.code(400).send(badRequest(body.error.issues.map(({ path }) => path.join('.'))));
    const grant = session.exchange(body.data.token);
    if (grant === null) return reply.code(401).send(refusal('session.token'));
    const name = cookieName(portOf(app.server));
    return reply
      .header('set-cookie', `${name}=${grant.cookie}; HttpOnly; SameSite=Strict; Path=/`)
      .send({ csrf: grant.csrf });
  });
  app.get('/api/session', async (req, reply) => {
    const grant = session.grantFor(cookieValues(req.headers.cookie, cookieName(portOf(app.server))));
    return grant === null ? reply.code(401).send(refusal('session.cookie')) : { csrf: grant.csrf };
  });
};

const SERVER = {
  frameworkErrors,
  // Node answers an HTTP/1.1 request without Host with its own 400; the guard answers it with 421 session.host.
  http: { requireHostHeader: false },
  // Fastify's 0 also turns off Node's own limit, and no proxy sits in front.
  requestTimeout: 30_000,
  forceCloseConnections: true,
} as const;

/** The local server: session security on every request, Refusal bodies for every error, and the session routes. */
export const buildServer = async ({ session, log }: ServerOptions): Promise<FastifyInstance> => {
  const app = Fastify(SERVER);
  // JSON only: a text/plain body is one a cross-site form can send without a preflight.
  app.removeContentTypeParser('text/plain');
  // Loopback HTTP: no HSTS, the whole CSP spelled out (helmet's defaults allow https: and upgrade); Mantine needs inline styles.
  await app.register(helmet, {
    hsts: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  app.addHook('onRequest', guard(session));
  app.addHook('onSend', async (_req, reply) => void reply.header('cache-control', 'no-store'));
  errors(app, log);
  sessionRoutes(app, session);
  return app;
};
