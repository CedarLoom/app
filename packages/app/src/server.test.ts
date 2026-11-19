import { describe, expect, it } from 'vitest';
import { buildServer } from './server.ts';
import { Session } from './session.ts';

// Not listening, the server's port is 0: its Host is 127.0.0.1:0 and its cookie cedarloom_session_0.
const HOST = '127.0.0.1:0';
const CSP =
  "default-src 'self';style-src 'self' 'unsafe-inline';object-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'";

// Secrets in order: the URL token secret-0, then the cookie secret-1 and the CSRF value secret-2.
const server = async () => {
  let now = 0;
  let count = 0;
  const session = new Session({ now: () => now, secret: () => `secret-${count++}` });
  const app = await buildServer({ session, log: () => undefined });
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

  it.each([
    ['a missing cookie', undefined],
    ['two same-named cookies with differing values', 'cedarloom_session_0=other; cedarloom_session_0=secret-1'],
  ])('refuses %s with 401 session.cookie', async (_case, cookie) => {
    const { app } = await server();
    await exchange(app, 'secret-0');
    const headers = cookie === undefined ? { host: HOST } : { host: HOST, cookie };
    const reply = await app.inject({ method: 'GET', url: '/api/session', headers });
    expect([reply.statusCode, reply.json()]).toEqual([401, { code: 'session.cookie', params: {} }]);
  });

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
