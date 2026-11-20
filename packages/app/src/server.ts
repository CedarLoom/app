import { type ServerResponse, STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';
import { inspect } from 'node:util';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import type { Code, Params } from '@cedarloom/core';
import { StepFailed } from '@cedarloom/use-cases';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { apiRoutes, ERRORS, type Project } from './api.ts';
import { cookieName, cookieValues, frameworkErrors, guard, portOf, type Session } from './session.ts';
import { uiRoutes } from './ui-files.ts';

export interface ServerOptions {
  session: Session;
  /** Where errors the client does not see go: the server's terminal. */
  log: (text: string) => void;
  project: Project;
  /** The built UI's folder; the server starts without it and answers 404 for its files. */
  ui: string;
}

const refusal = (code: Code, params: Params = {}): { code: Code; params: Params } => ({ code, params });

// A schema's issues by field; a root issue (not an object, an unknown key) names none.
const badRequest = (error: FastifyError): ReturnType<typeof refusal> => {
  const issues = (error.validation ?? []).flatMap(({ instancePath }) =>
    instancePath.length > 1 ? [instancePath.slice(1).replaceAll('/', '.')] : [],
  );
  return issues.length === 0 ? refusal('api.bad-request') : refusal('api.bad-fields', { issues });
};

// Fastify's own request errors (validation 400, body over bodyLimit 413, wrong content type 415, malformed JSON 400).
const requestError = (error: unknown): error is FastifyError & { statusCode: number } => {
  if (!(error instanceof Error) || !('code' in error) || !('statusCode' in error)) return false;
  const { code, statusCode } = error;
  return typeof code === 'string' && code.startsWith('FST_ERR_') && typeof statusCode === 'number' && statusCode < 500;
};

// Anything else is internal, a thrown non-Error too; a failed step's 500 names its run, whose earlier steps may have written.
const errors = (app: FastifyInstance, log: (text: string) => void): void => {
  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (requestError(error)) return reply.code(error.statusCode).send(badRequest(error));
    // The request stream's own error (a client gone mid-body), which Fastify's body reader passes on.
    if (error instanceof Error && error === req.raw.errored) return reply.code(400).send(refusal('api.bad-request'));
    // depth null: the default hides a finding's params, such as the path of a recovery.skipped in StepFailed.
    log(`${inspect(error, { depth: null })}\n`);
    const run = error instanceof StepFailed ? { run: error.run } : {};
    return reply.code(500).send({ ...refusal('api.internal'), ...run });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(refusal('api.not-found')));
};

const Exchange = z.strictObject({ token: z.string() }).meta({ id: 'SessionExchange' });
const Csrf = z.strictObject({ csrf: z.string() }).meta({ id: 'SessionCsrf' });

/** POST exchanges the URL token for the cookie and the CSRF value; GET gives the CSRF value again for the cookie. */
const sessionRoutes = (app: FastifyInstance, session: Session): void => {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.post(
    '/api/session',
    { schema: { body: Exchange, response: { 200: Csrf, ...ERRORS } } },
    async (req, reply) => {
      const grant = session.exchange(req.body.token);
      if (grant === null) return reply.code(401).send(refusal('session.token'));
      const name = cookieName(portOf(app.server));
      return reply
        .header('set-cookie', `${name}=${grant.cookie}; HttpOnly; SameSite=Strict; Path=/`)
        .send({ csrf: grant.csrf });
    },
  );
  routes.get('/api/session', { schema: { response: { 200: Csrf, ...ERRORS } } }, async (req, reply) => {
    const grant = session.grantFor(cookieValues(req.headers.cookie, cookieName(portOf(app.server))));
    return grant === null ? reply.code(401).send(refusal('session.cookie')) : { csrf: grant.csrf };
  });
};

const SOCKET_STATUS: Readonly<Record<string, number>> = {
  ERR_HTTP_REQUEST_TIMEOUT: 408,
  HPE_HEADER_OVERFLOW: 431,
  HPE_CHUNK_EXTENSIONS_OVERFLOW: 413,
};

// The last response on each socket: Node keeps it only in a private field.
const responses = new WeakMap<Socket, ServerResponse>();

// Node's answers at the socket, before any route (a request timeout, a malformed request), with Node's statuses.
const clientErrorHandler = (error: Error & { code?: string }, socket: Socket): void => {
  if (error.code === 'ECONNRESET' || socket.destroyed) return;
  const response = responses.get(socket);
  // As Node's own handler: an answer after a response's headers would land inside that response.
  const inFlight = response !== undefined && response.headersSent && !response.writableFinished;
  const status = SOCKET_STATUS[error.code ?? ''] ?? 400;
  const body = JSON.stringify(refusal('api.bad-request'));
  const head = `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}`;
  const headers = 'Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close';
  if (socket.writable && !inFlight) socket.write(`${head}\r\n${headers}\r\n\r\n${body}`);
  socket.destroy(error);
};

const SERVER = {
  frameworkErrors,
  clientErrorHandler,
  // Node answers an HTTP/1.1 request without Host with its own 400; the guard answers it with 421 session.host.
  http: { requireHostHeader: false },
  // Fastify's 0 also turns off Node's own limit, and no proxy sits in front.
  requestTimeout: 30_000,
  forceCloseConnections: true,
} as const;

/** The local server: session security on every request, Refusal bodies for every error, the API and the UI's files. */
export const buildServer = async ({ session, log, project, ui }: ServerOptions): Promise<FastifyInstance> => {
  const app = Fastify(SERVER);
  app.server.on('request', (req, res) => responses.set(req.socket, res));
  // Zod schemas validate requests and responses and make the OpenAPI document; swagger collects the routes added after it.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: { openapi: '3.1.0', info: { title: 'cedarloom-app', version: '0.0.0' } },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
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
  apiRoutes(app, project);
  uiRoutes(app, ui);
  return app;
};
