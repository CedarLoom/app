import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { Finding } from '@cedarloom/core';
import { StepFailed } from '@cedarloom/use-cases';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.ts';
import { portOf, Session } from './session.ts';

// Not listening, the server's port is 0: its Host is 127.0.0.1:0 and its cookie cedarloom_session_0.
const HOST = '127.0.0.1:0';
const CSP =
  "default-src 'self';style-src 'self' 'unsafe-inline';object-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'";

// No route of these tests reaches the project.
const PROJECT = {
  root: '',
  storeDir: '',
  clock: { now: () => new Date(0), newRunId: () => 'r1' },
  node: '26.13.0',
  required: '>=26',
  cwd: '',
  env: {},
  home: '',
  pluginRoot: null,
};

// A built UI in base/ui, a file beside it, base/ui/assets/out linking to a folder outside it and base/ui/assets/up to base/ui.
const base = mkdtempSync(join(tmpdir(), 'cedarloom-ui-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const built = join(base, 'ui');
mkdirSync(join(built, 'assets'), { recursive: true });
mkdirSync(join(base, 'outside'));
writeFileSync(join(built, 'index.html'), '<!doctype html><title>ui</title>');
writeFileSync(join(built, 'assets', 'app.js'), 'export {};');
writeFileSync(join(base, 'package.json'), '{"secret":true}');
writeFileSync(join(base, 'outside', 'secret.txt'), 'secret');
// A junction needs no privilege on Windows; other platforms ignore the type.
symlinkSync(join(base, 'outside'), join(built, 'assets', 'out'), 'junction');
symlinkSync(built, join(built, 'assets', 'up'), 'junction');
// A UI in base/linked whose assets folder links to the folder outside it.
const linked = join(base, 'linked');
mkdirSync(linked);
symlinkSync(join(base, 'outside'), join(linked, 'assets'), 'junction');

// Secrets in order: the URL token secret-0, then the cookie secret-1 and the CSRF value secret-2.
// Most tests have no UI built: the folder does not exist.
const server = async (ui = join(base, 'missing')) => {
  let now = 0;
  let count = 0;
  const session = new Session({ now: () => now, secret: () => `secret-${count++}` });
  const log: string[] = [];
  const app = await buildServer({ session, log: (text) => void log.push(text), project: PROJECT, ui });
  const advance = (ms: number): void => {
    now += ms;
  };
  return { app, advance, log };
};

type App = Awaited<ReturnType<typeof server>>['app'];
const exchange = (app: App, token: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/session', headers: { host: HOST, ...headers }, payload: { token } });
const withCookie = { host: HOST, cookie: 'cedarloom_session_0=secret-1' };

describe('session exchange', () => {
  it('sets the cookie with HttpOnly, SameSite=Strict and Path=/ and returns the CSRF value', async () => {
    const { app } = await server();
    const reply = await exchange(app, 'secret-0');
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['set-cookie']).toBe('cedarloom_session_0=secret-1; HttpOnly; SameSite=Strict; Path=/');
    expect(reply.json()).toEqual({ csrf: 'secret-2' });
  });

  it('refuses a second exchange with 401 session.token', async () => {
    const { app } = await server();
    await exchange(app, 'secret-0');
    const reply = await exchange(app, 'secret-0');
    expect([reply.statusCode, reply.json()]).toEqual([401, { code: 'session.token', params: {} }]);
  });

  it('accepts the token up to 10 minutes after start and refuses it after with 401 session.token', async () => {
    const late = await server();
    late.advance(600_000);
    const refused = await exchange(late.app, 'secret-0');
    expect([refused.statusCode, refused.json()]).toEqual([401, { code: 'session.token', params: {} }]);
    const early = await server();
    early.advance(599_999);
    expect((await exchange(early.app, 'secret-0')).statusCode).toBe(200);
  });

  it('refuses a body without a token with 400 api.bad-fields naming the field', async () => {
    const { app } = await server();
    const reply = await app.inject({ method: 'POST', url: '/api/session', headers: { host: HOST }, payload: {} });
    expect([reply.statusCode, reply.json()]).toEqual([400, { code: 'api.bad-fields', params: { issues: ['token'] } }]);
  });

  it('refuses an unknown key with 400 api.bad-request naming no field', async () => {
    const { app } = await server();
    const payload = { token: 'secret-0', extra: 1 };
    const reply = await app.inject({ method: 'POST', url: '/api/session', headers: { host: HOST }, payload });
    expect([reply.statusCode, reply.json()]).toEqual([400, { code: 'api.bad-request', params: {} }]);
  });
});

describe('request guard', () => {
  it('refuses a wrong Host with 421 session.host and closes the connection', async () => {
    const { app } = await server();
    const reply = await app.inject({ method: 'GET', url: '/api/session', headers: { host: 'localhost:0' } });
    expect([reply.statusCode, reply.json()]).toEqual([421, { code: 'session.host', params: {} }]);
    expect(reply.headers.connection).toBe('close');
  });

  it('refuses another Origin with 403 session.origin', async () => {
    const { app } = await server();
    const reply = await exchange(app, 'secret-0', { origin: 'http://127.0.0.1:8080' });
    expect([reply.statusCode, reply.json()]).toEqual([403, { code: 'session.origin', params: {} }]);
  });

  it('refuses Sec-Fetch-Site same-site with 403 session.origin', async () => {
    const { app } = await server();
    await exchange(app, 'secret-0');
    const reply = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { ...withCookie, 'sec-fetch-site': 'same-site' },
    });
    expect([reply.statusCode, reply.json()]).toEqual([403, { code: 'session.origin', params: {} }]);
  });

  it.each([
    ['a missing cookie', 'GET', '/api/session', undefined],
    ['a missing cookie on an unknown API path', 'GET', '/api/nope', undefined],
    ['a missing cookie on a POST outside /api/', 'POST', '/nope', undefined],
    [
      'two same-named cookies with differing values',
      'GET',
      '/api/session',
      'cedarloom_session_0=other; cedarloom_session_0=secret-1',
    ],
    [
      'the same two cookies in the other order',
      'GET',
      '/api/session',
      'cedarloom_session_0=secret-1; cedarloom_session_0=other',
    ],
  ] as const)('refuses %s with 401 session.cookie', async (_case, method, url, cookie) => {
    const { app } = await server();
    await exchange(app, 'secret-0');
    const headers = cookie === undefined ? { host: HOST } : { host: HOST, cookie };
    const reply = await app.inject({ method, url, headers });
    expect([reply.statusCode, reply.json()]).toEqual([401, { code: 'session.cookie', params: {} }]);
  });
});

describe('request guard, navigation from the redirect page', () => {
  const navigation = {
    host: HOST,
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  };

  // No UI is built here, so a passing request reaches the 404 of a missing file.
  it('lets a cross-site GET navigation to a document outside /api/ pass', async () => {
    const { app } = await server();
    const reply = await app.inject({ method: 'GET', url: '/', headers: navigation });
    expect(reply.statusCode).toBe(404);
  });

  // A HEAD reply has no body, so its status tells the refusal from the 404 of a passing request.
  it('refuses a cross-site HEAD navigation with 403', async () => {
    const { app } = await server();
    const reply = await app.inject({ method: 'HEAD', url: '/', headers: navigation });
    expect(reply.statusCode).toBe(403);
  });

  it.each([
    ['mode no-cors', 'GET', '/', { 'sec-fetch-mode': 'no-cors' }],
    ['mode cors', 'GET', '/', { 'sec-fetch-mode': 'cors' }],
    ['no mode', 'GET', '/', { 'sec-fetch-mode': undefined }],
    ['dest iframe', 'GET', '/', { 'sec-fetch-dest': 'iframe' }],
    ['dest script', 'GET', '/', { 'sec-fetch-dest': 'script' }],
    ['no dest', 'GET', '/', { 'sec-fetch-dest': undefined }],
    ['method POST', 'POST', '/', {}],
    ['an /api/ path', 'GET', '/api/session', {}],
    ['an encoded /api/ path', 'GET', '/%61pi/session', {}],
    ['site same-site', 'GET', '/', { 'sec-fetch-site': 'same-site' }],
  ] as const)('refuses a cross-site request with %s with 403 session.origin', async (_case, method, url, changed) => {
    const { app } = await server();
    const headers = Object.fromEntries(
      Object.entries({ ...navigation, ...changed }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const reply = await app.inject({ method, url, headers });
    expect([reply.statusCode, reply.json()]).toEqual([403, { code: 'session.origin', params: {} }]);
  });
});

describe('request guard, CSRF and headers', () => {
  it('returns the CSRF value again for the cookie', async () => {
    const { app } = await server();
    await exchange(app, 'secret-0');
    const reply = await app.inject({ method: 'GET', url: '/api/session', headers: withCookie });
    expect([reply.statusCode, reply.json()]).toEqual([200, { csrf: 'secret-2' }]);
  });

  it.each(['POST', 'DELETE'] as const)('refuses %s without the CSRF header with 403 session.csrf', async (method) => {
    const { app } = await server();
    await exchange(app, 'secret-0');
    const reply = await app.inject({ method, url: '/api/runs', headers: withCookie });
    expect([reply.statusCode, reply.json()]).toEqual([403, { code: 'session.csrf', params: {} }]);
  });

  it('refuses a wrong CSRF value with 403 session.csrf', async () => {
    const { app } = await server();
    await exchange(app, 'secret-0');
    const headers = { ...withCookie, 'x-cedarloom-csrf': 'secret-1' };
    const reply = await app.inject({ method: 'POST', url: '/api/runs', headers });
    expect([reply.statusCode, reply.json()]).toEqual([403, { code: 'session.csrf', params: {} }]);
  });

  it('sends the CSP and no CORS header on any answer', async () => {
    const { app } = await server();
    const replies = [
      await app.inject({ method: 'OPTIONS', url: '/api/session', headers: { host: HOST, origin: 'http://x.test' } }),
      await exchange(app, 'secret-0'),
      await app.inject({ method: 'GET', url: '/api/session', headers: withCookie }),
      await app.inject({ method: 'GET', url: '/api/session', headers: { host: HOST } }),
    ];
    for (const reply of replies) {
      expect(reply.headers['content-security-policy']).toBe(CSP);
      expect(Object.keys(reply.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
    }
  });
});

describe('errors', () => {
  const session = { ...withCookie, 'x-cedarloom-csrf': 'secret-2' };

  it.each([
    ['/api/nope', withCookie],
    ['/nope', { host: HOST }],
  ])('answers the unknown path %s with 404 api.not-found', async (url, headers) => {
    const { app } = await server();
    await exchange(app, 'secret-0');
    const reply = await app.inject({ method: 'GET', url, headers });
    expect([reply.statusCode, reply.json()]).toEqual([404, { code: 'api.not-found', params: {} }]);
  });

  it('refuses a malformed URL with a wrong Host with 421 session.host', async () => {
    const { app } = await server();
    const reply = await app.inject({ method: 'GET', url: '/%zz', headers: { host: 'localhost:0' } });
    expect([reply.statusCode, reply.json()]).toEqual([421, { code: 'session.host', params: {} }]);
  });

  it('answers a body over the limit with 413 api.bad-request', async () => {
    const { app } = await server();
    const reply = await exchange(app, 'x'.repeat(1_048_577));
    expect([reply.statusCode, reply.json()]).toEqual([413, { code: 'api.bad-request', params: {} }]);
  });

  it('answers a text/plain body with 415 api.bad-request', async () => {
    const { app } = await server();
    await exchange(app, 'secret-0');
    const reply = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { ...session, 'content-type': 'text/plain' },
      payload: '{"token":"secret-0"}',
    });
    expect([reply.statusCode, reply.json()]).toEqual([415, { code: 'api.bad-request', params: {} }]);
  });
});

// Everything the server sends on one connection until it closes it; next[1] goes out once that text holds next[0].
const received = async (
  app: App,
  request: (self: string) => string,
  next?: [after: string, then: string],
): Promise<string> => {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = connect(portOf(app.server), '127.0.0.1').setEncoding('utf8');
  // The server may have closed before next[1] arrives.
  socket.on('error', () => {});
  socket.write(request(`127.0.0.1:${portOf(app.server)}`));
  let text = '';
  let follow = next;
  socket.on('data', (chunk: string) => {
    text += chunk;
    if (follow === undefined || !text.includes(follow[0])) return;
    socket.write(follow[1]);
    follow = undefined;
  });
  await new Promise((resolve) => socket.on('close', resolve));
  await app.close();
  return text;
};

describe('errors at the socket', () => {
  const BAD_REQUEST = '{"code":"api.bad-request","params":{}}';

  it.each([
    ['a malformed request', () => 'NOT-HTTP\r\n\r\n', 'HTTP/1.1 400 Bad Request'],
    [
      'a header block over 16 KiB',
      () => `GET / HTTP/1.1\r\nHost: ${HOST}\r\nX-Big: ${'a'.repeat(17_000)}\r\n\r\n`,
      'HTTP/1.1 431 Request Header Fields Too Large',
    ],
    [
      // A route that reads the body: one that answers first would make the row depend on how the bytes arrive.
      'chunk extensions over 16 KiB',
      (_app: App, self: string) =>
        `POST /api/session HTTP/1.1\r\nHost: ${self}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1;${'a'.repeat(17_000)}\r\n`,
      'HTTP/1.1 413 Payload Too Large',
    ],
    [
      // The timeout takes 30 s to come, so this row raises Node's error on the connection itself.
      'a request timeout',
      (app: App) => {
        const timeout = Object.assign(new Error('timeout'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' });
        app.server.once('connection', (socket) => app.server.emit('clientError', timeout, socket));
        return '';
      },
      'HTTP/1.1 408 Request Timeout',
    ],
  ])('answers %s with its status and api.bad-request', async (_case, request, status) => {
    const { app } = await server();
    const text = await received(app, (self) => request(app, self));
    expect([text.split('\r\n')[0], text.split('\r\n\r\n')[1]]).toEqual([status, BAD_REQUEST]);
  });
});

describe('errors at the socket after an answer', () => {
  // Over 16 KiB, sent once the first answer is in: the error comes in the body of a request already answered.
  const extension = `1;${'a'.repeat(17_000)}\r\n`;
  it.each([
    ['a wrong Host', () => 'localhost:0', 'HTTP/1.1 421'],
    ['an unknown path', (host: string) => host, 'HTTP/1.1 404'],
  ])(
    'writes nothing after its answer to %s whose chunk extensions run over, and closes',
    async (_case, host, status) => {
      const { app } = await server();
      const text = await received(
        app,
        (self) => `GET /nope HTTP/1.1\r\nHost: ${host(self)}\r\nTransfer-Encoding: chunked\r\n\r\n`,
        ['"params":{}}', extension],
      );
      expect(text.match(/HTTP\/1\.1 \d{3}/g)).toEqual([status]);
    },
  );

  it('answers a malformed request after the responses before it, none inside one', async () => {
    const { app } = await server();
    // Pipelined: /streams sends its head once /waits is queued and its end once the malformed request comes; /waits sends then.
    const queued = new Promise<() => void>((resolve) => {
      app.get('/waits', (_req, reply) => resolve(() => void reply.send('done')));
    });
    app.get('/streams', async (_req, reply) => {
      const send = await queued;
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/plain' });
      reply.raw.write('partial');
      app.server.once('clientError', () => {
        reply.raw.end('rest');
        send();
      });
    });
    const text = await received(
      app,
      (self) => `GET /streams HTTP/1.1\r\nHost: ${self}\r\n\r\nGET /waits HTTP/1.1\r\nHost: ${self}\r\n\r\n`,
      ['partial', 'NOT-HTTP\r\n\r\n'],
    );
    expect(text.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200', 'HTTP/1.1 200', 'HTTP/1.1 400']);
    expect(text).toContain('partial\r\n4\r\nrest\r\n0\r\n\r\nHTTP/1.1 200');
    expect(text).toMatch(
      /\r\n\r\ndoneHTTP\/1\.1 400 Bad Request\r\n.*\r\n\r\n\{"code":"api.bad-request","params":\{\}\}$/s,
    );
  });
});

describe('errors at the socket during a response', () => {
  it('writes no answer into a response whose headers are out and closes the connection at the request timeout', async () => {
    const { app } = await server();
    app.get('/streams', (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/plain' });
      reply.raw.write('partial');
    });
    // The malformed request waits for the response; Node's timeout, raised here, ends the wait.
    const timeout = Object.assign(new Error('timeout'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' });
    app.server.once('clientError', (_error, socket) => app.server.emit('clientError', timeout, socket));
    const text = await received(app, (self) => `GET /streams HTTP/1.1\r\nHost: ${self}\r\n\r\n`, [
      'partial',
      'NOT-HTTP\r\n\r\n',
    ]);
    expect(text).toContain('partial');
    expect(text).not.toContain('api.bad-request');
  });

  it('closes at a request timeout behind an unfinished response, and the timed-out request never reaches its route', async () => {
    const { app } = await server();
    let reached = false;
    let streams: (() => void) | undefined;
    // Node's timeout, raised here once 'partial' is out; /fast ends /streams so that a served /fast cannot hang the test.
    app.get('/streams', (req, reply) => {
      reply.hijack();
      streams = () => void reply.raw.end('rest');
      reply.raw.writeHead(200, { 'content-type': 'text/plain' });
      const timeout = Object.assign(new Error('timeout'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' });
      reply.raw.write('partial', () => void app.server.emit('clientError', timeout, req.raw.socket));
    });
    app.get('/fast', () => {
      reached = true;
      streams?.();
      return 'fast';
    });
    // The headers of /fast end only once 'partial' has arrived.
    const text = await received(
      app,
      (self) => `GET /streams HTTP/1.1\r\nHost: ${self}\r\n\r\nGET /fast HTTP/1.1\r\nHost: ${self}\r\n`,
      ['partial', '\r\n'],
    );
    expect([reached, text.match(/HTTP\/1\.1 \d{3}/g)]).toEqual([false, ['HTTP/1.1 200']]);
    expect(text).toContain('partial');
  });
});

describe('errors inside routes', () => {
  it('answers a client gone mid-body with 400 api.bad-request and logs nothing', async () => {
    const { app, log } = await server();
    const answered = new Promise<number>((resolve) => {
      app.addHook('onSend', async (_req, reply) => {
        resolve(reply.statusCode);
      });
    });
    // The client leaves once the server starts reading the body, 5 of its 100 bytes sent.
    app.addHook('preParsing', async (_req, _reply, payload) => {
      socket.destroy();
      return payload;
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = connect(portOf(app.server), '127.0.0.1');
    socket.write(
      `POST /api/session HTTP/1.1\r\nHost: 127.0.0.1:${portOf(app.server)}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"tok`,
    );
    const status = await answered;
    await app.close();
    expect([status, log]).toEqual([400, []]);
  });

  const skipped: Finding = {
    code: 'recovery.skipped',
    severity: 'error',
    params: { path: '.claude/skipped.md', run: 'u1' },
  };
  it.each([
    ['a 4xx error not of Fastify', Object.assign(new Error('tea\u202epot'), { statusCode: 418 }), {}, 'tea\\u202epot'],
    ['null', null, {}, 'null'],
    ['an error with a cause', new Error('outer', { cause: new Error('the cause') }), {}, 'the cause'],
    ['StepFailed', new StepFailed('u1', [skipped], new Error('step')), { run: 'u1' }, '.claude/skipped.md'],
  ])('answers a route throwing %s with 500 api.internal and logs it', async (_case, thrown, run, logged) => {
    const { app, log } = await server();
    app.get('/api/throws', async () => {
      throw thrown;
    });
    await exchange(app, 'secret-0');
    const reply = await app.inject({ method: 'GET', url: '/api/throws', headers: withCookie });
    expect([reply.statusCode, reply.json()]).toEqual([500, { code: 'api.internal', params: {}, ...run }]);
    expect(log.join('')).toContain(logged);
  });
});

describe('UI files', () => {
  it('serves index.html for /', async () => {
    const { app } = await server(built);
    const reply = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
    expect([reply.statusCode, reply.headers['content-type'], reply.body]).toEqual([
      200,
      'text/html; charset=utf-8',
      '<!doctype html><title>ui</title>',
    ]);
    expect(reply.headers['content-security-policy']).toBe(CSP);
  });

  it('serves an asset with its content type', async () => {
    const { app } = await server(built);
    const reply = await app.inject({ method: 'GET', url: '/assets/app.js', headers: { host: HOST } });
    expect([reply.statusCode, reply.headers['content-type'], reply.body]).toEqual([
      200,
      'text/javascript; charset=utf-8',
      'export {};',
    ]);
  });

  it.each([
    ['an encoded parent path', '/assets/..%2f..%2fpackage.json'],
    ['a parent path with backslashes', '/assets/..%5c..%5cpackage.json'],
    ['a NUL byte', '/assets/app.js%00'],
    ['a link out of the folder', '/assets/out/secret.txt'],
    ['an encoded parent path to a UI file outside assets', '/assets/..%2findex.html'],
    ['a link to a UI file outside assets', '/assets/up/index.html'],
    // Without its drive on Windows: the same folder on the root's drive.
    ['an absolute path', `/assets/${encodeURIComponent(join(built, 'assets', 'app.js').replace(/^[A-Za-z]:/, ''))}`],
    ['a folder', '/assets/'],
    ['a missing file', '/assets/nope.js'],
    ['a name longer than a file system allows', `/assets/${'a'.repeat(300)}.js`],
  ])('answers %s with 404 api.not-found', async (_case, url) => {
    const { app } = await server(built);
    const reply = await app.inject({ method: 'GET', url, headers: { host: HOST } });
    expect([reply.statusCode, reply.json()]).toEqual([404, { code: 'api.not-found', params: {} }]);
  });

  it('answers a file of an assets folder that links out of the UI folder with 404 api.not-found', async () => {
    const { app } = await server(linked);
    const reply = await app.inject({ method: 'GET', url: '/assets/secret.txt', headers: { host: HOST } });
    expect([reply.statusCode, reply.json()]).toEqual([404, { code: 'api.not-found', params: {} }]);
  });
});
