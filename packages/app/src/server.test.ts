import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.ts';
import { Session } from './session.ts';

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
  const app = await buildServer({ session, log: () => undefined, project: PROJECT, ui });
  const advance = (ms: number): void => {
    now += ms;
  };
  return { app, advance };
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

  it('refuses a body without a token with 400 api.bad-request naming the field', async () => {
    const { app } = await server();
    const reply = await app.inject({ method: 'POST', url: '/api/session', headers: { host: HOST }, payload: {} });
    expect([reply.statusCode, reply.json()]).toEqual([400, { code: 'api.bad-request', params: { issues: ['token'] } }]);
  });

  it('refuses an unknown key with 400 api.bad-request naming no field', async () => {
    const { app } = await server();
    const payload = { token: 'secret-0', extra: 1 };
    const reply = await app.inject({ method: 'POST', url: '/api/session', headers: { host: HOST }, payload });
    expect([reply.statusCode, reply.json()]).toEqual([400, { code: 'api.bad-request', params: { issues: [] } }]);
  });
});

describe('request guard', () => {
  it('refuses a wrong Host with 421 session.host', async () => {
    const { app } = await server();
    const reply = await app.inject({ method: 'GET', url: '/api/session', headers: { host: 'localhost:0' } });
    expect([reply.statusCode, reply.json()]).toEqual([421, { code: 'session.host', params: {} }]);
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
    expect([reply.statusCode, reply.json()]).toEqual([413, { code: 'api.bad-request', params: { issues: [] } }]);
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
    expect([reply.statusCode, reply.json()]).toEqual([415, { code: 'api.bad-request', params: { issues: [] } }]);
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
