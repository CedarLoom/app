import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { recordRun } from '../scripts/recorded-run.ts';
import { buildServer } from './server.ts';
import { Session } from './session.ts';

const HOST = '127.0.0.1:0';
const NOTES = 'ab5aa97074c454a0632057e704220d9a6678fbf773a0a5806fc09b8173b07309';
const RUN_PLAN = '9a61f930ebe8d14eff200417fff3400460c6ecc0836074c03ab5d54065ef0b2a';
const UNDO_PLAN = '1dcd6e6c09b8288243cc3586f9338f22d036fd7c8709bc4dbe548301dc1207cc';
const STALE = '0'.repeat(64);

// Each test's folders and server go when it ends.
const folder = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'cedarloom-api-')));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

const r1 = {
  id: 'r1',
  kind: 'apply',
  action: 'workflow.new',
  subject: 'notes',
  status: 'done',
  startedAt: '2026-11-19T06:00:00.000Z',
  endedAt: '2026-11-19T06:00:00.000Z',
  undoes: null,
  undoneBy: null,
};

// A project whose store holds run r1, and a server with an exchanged session: cookie secret-1, CSRF value secret-2.
const served = async () => {
  const root = folder();
  mkdirSync(join(root, '.git'));
  const storeDir = folder();
  recordRun(root, storeDir);
  let count = 0;
  const session = new Session({ now: () => 0, secret: () => `secret-${count++}` });
  const clock = { now: () => new Date('2026-11-19T07:00:00.000Z'), newRunId: () => 'u1' };
  const plugins = folder();
  const env = { CLAUDE_CODE_PLUGIN_CACHE_DIR: plugins, CLAUDE_CONFIG_DIR: folder() };
  const doctorInputs = { node: '26.13.0', required: '>=26', cwd: root, env, home: '', pluginRoot: null };
  const project = { root, storeDir, clock, ...doctorInputs };
  const app = await buildServer({ session, log: () => undefined, project, ui: join(root, 'ui') });
  onTestFinished(() => app.close());
  await app.inject({ method: 'POST', url: '/api/session', headers: { host: HOST }, payload: { token: 'secret-0' } });
  const notes = join(root, '.claude', 'notes.md');
  return { app, notes, plugins };
};

type App = Awaited<ReturnType<typeof served>>['app'];
const cookie = { host: HOST, cookie: 'cedarloom_session_0=secret-1' };
const get = (app: App, url: string) => app.inject({ method: 'GET', url, headers: cookie });
const post = (
  app: App,
  url: string,
  planHash: string,
  headers: Record<string, string> = { 'x-cedarloom-csrf': 'secret-2' },
) => app.inject({ method: 'POST', url, headers: { ...cookie, ...headers }, payload: { planHash } });
const answer = (reply: { statusCode: number; json: () => unknown }) => [reply.statusCode, reply.json()];

describe('reads', () => {
  it('answers GET /api/doctor with the report and its findings', async () => {
    const { app, plugins } = await served();
    expect(answer(await get(app, '/api/doctor'))).toEqual([
      200,
      {
        checks: [
          { id: 'node', status: 'pass' },
          { id: 'project', status: 'pass' },
          { id: 'plugin', status: 'fail' },
          { id: 'definitions', status: 'skipped' },
          { id: 'generated', status: 'skipped' },
        ],
        plugin: null,
        findings: [{ code: 'plugin.not-found', severity: 'error', params: { pluginsRoot: plugins } }],
      },
    ]);
  });

  it('answers GET /api/runs with the run summaries', async () => {
    const { app } = await served();
    expect(answer(await get(app, '/api/runs'))).toEqual([200, { runs: [r1] }]);
  });

  it('answers GET /api/runs/{id} with the run and its steps', async () => {
    const { app } = await served();
    const steps = [
      { kind: 'create', path: '.claude/notes.md', beforeHash: null, afterHash: NOTES, status: 'done', entries: null },
    ];
    expect(answer(await get(app, '/api/runs/r1'))).toEqual([
      200,
      { ...r1, planHash: RUN_PLAN, operations: steps, generatedFrom: [] },
    ]);
  });

  it.each(['/api/runs/r2', '/api/runs/r2/undo'])(
    'answers GET %s for an unknown run with 404 run.not-found',
    async (url) => {
      const { app } = await served();
      expect(answer(await get(app, url))).toEqual([404, { code: 'run.not-found', params: { run: 'r2' } }]);
    },
  );

  it.each(['/api/runs/-r1', '/api/runs/-r1/undo'])('refuses GET %s with 400 api.bad-request naming id', async (url) => {
    const { app } = await served();
    expect(answer(await get(app, url))).toEqual([400, { code: 'api.bad-request', params: { issues: ['id'] } }]);
  });

  it.each(['', '/undo'])('refuses GET /api/runs/{id}%s with an id over the router limit with 400', async (rest) => {
    const { app } = await served();
    const reply = await get(app, `/api/runs/${'a'.repeat(101)}${rest}`);
    expect(answer(reply)).toEqual([400, { code: 'api.bad-request', params: { issues: [] } }]);
  });
});

describe('undo preview', () => {
  const deleted = {
    kind: 'delete',
    path: '.claude/notes.md',
    beforeHash: NOTES,
    afterHash: null,
    before: 'notes',
    after: null,
  };

  it('answers GET /api/runs/{id}/undo with the plan and its hash', async () => {
    const { app } = await served();
    expect(answer(await get(app, '/api/runs/r1/undo'))).toEqual([
      200,
      { planHash: UNDO_PLAN, plan: { planHash: UNDO_PLAN, operations: [deleted], skipped: [] }, refusals: [] },
    ]);
  });

  it('answers GET /api/runs/{id}/undo with null keys and the refusal when the undo is refused', async () => {
    const { app, notes } = await served();
    writeFileSync(notes, 'edited');
    expect(answer(await get(app, '/api/runs/r1/undo'))).toEqual([
      200,
      { planHash: null, plan: null, refusals: [{ code: 'undo.file-changed', params: { path: '.claude/notes.md' } }] },
    ]);
  });
});

describe('undo apply', () => {
  it('applies the undo for the hash of its plan and records the undo run', async () => {
    const { app, notes } = await served();
    const undone = {
      ...r1,
      id: 'u1',
      kind: 'undo',
      action: 'undo',
      subject: 'r1',
      startedAt: '2026-11-19T07:00:00.000Z',
      endedAt: '2026-11-19T07:00:00.000Z',
      undoes: 'r1',
    };
    expect(answer(await post(app, '/api/runs/r1/undo', UNDO_PLAN))).toEqual([200, { run: undone }]);
    expect(existsSync(notes)).toBe(false);
    expect((await get(app, '/api/runs/r1')).json()).toMatchObject({ undoneBy: 'u1' });
  });
});

describe('undo apply refusals', () => {
  it.each([
    {
      refused: 'a stale plan hash with 409 plan.stale',
      planHash: STALE,
      headers: undefined,
      status: 409,
      code: 'plan.stale',
    },
    {
      refused: 'a missing CSRF header with 403 session.csrf',
      planHash: UNDO_PLAN,
      headers: {},
      status: 403,
      code: 'session.csrf',
    },
    {
      refused: 'a missing cookie with 401 session.cookie',
      planHash: UNDO_PLAN,
      headers: { cookie: '' },
      status: 401,
      code: 'session.cookie',
    },
  ])('refuses $refused and changes nothing', async ({ planHash, headers, status, code }) => {
    const { app, notes } = await served();
    expect(answer(await post(app, '/api/runs/r1/undo', planHash, headers))).toEqual([status, { code, params: {} }]);
    expect(existsSync(notes)).toBe(true);
    expect((await get(app, '/api/runs')).json()).toEqual({ runs: [r1] });
  });

  it('refuses POST without a plan hash with 400 api.bad-request naming planHash', async () => {
    const { app } = await served();
    const reply = await app.inject({
      method: 'POST',
      url: '/api/runs/r1/undo',
      headers: { ...cookie, 'x-cedarloom-csrf': 'secret-2' },
      payload: {},
    });
    expect(answer(reply)).toEqual([400, { code: 'api.bad-request', params: { issues: ['planHash'] } }]);
  });

  it('answers a refusal of the undo with 409 and its code', async () => {
    const { app, notes } = await served();
    writeFileSync(notes, 'edited');
    expect(answer(await post(app, '/api/runs/r1/undo', UNDO_PLAN))).toEqual([
      409,
      { code: 'undo.file-changed', params: { path: '.claude/notes.md' } },
    ]);
  });
});
