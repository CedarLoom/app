import {
  DoctorResult,
  Refusal,
  Run,
  RunId,
  RunList,
  type RunSummary,
  UndoApplied,
  UndoApply,
  UndoPreview,
} from '@cedarloom/core';
import {
  doctor,
  type Opened,
  openRunView,
  openStore,
  planUndo,
  type RunStore,
  type RunView,
  type StoreClock,
  undo,
} from '@cedarloom/use-cases';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/** What the API routes act on: the project the server started in, its store, and the inputs of the Node.js check. */
export interface Project {
  root: string;
  storeDir: string;
  clock: StoreClock;
  /** The running Node.js version and the package's engines.node range. */
  node: string;
  required: string;
}

// Named components of the OpenAPI document, so the client generated from it names its types.
const BODIES = {
  doctor: DoctorResult.meta({ id: 'DoctorResult' }),
  runs: RunList.meta({ id: 'RunList' }),
  run: Run.meta({ id: 'Run' }),
  preview: UndoPreview.meta({ id: 'UndoPreview' }),
  apply: UndoApply.meta({ id: 'UndoApply' }),
  applied: UndoApplied.meta({ id: 'UndoApplied' }),
  refusal: Refusal.meta({ id: 'Refusal' }),
};

/** Every error body is a Refusal: the guard and the error handler can answer any route with one. */
export const ERRORS = { '4xx': BODIES.refusal, '5xx': BODIES.refusal } as const;
const RunPath = z.strictObject({ id: RunId });

const refuse = (reply: FastifyReply, refusal: Refusal): FastifyReply =>
  reply.code(refusal.code === 'run.not-found' ? 404 : 409).send(refusal);

const summary = ({ planHash: _plan, operations: _steps, generatedFrom: _from, ...run }: Run): RunSummary => run;

// Per request, as the CLI per command: an open store would hold its lock between requests.
const viewed = <T>(project: Project, read: (view: RunView) => Opened<T>): Opened<T> => {
  const view = openRunView(project.storeDir);
  if (!view.ok) return view;
  try {
    return read(view.value);
  } finally {
    view.value.close();
  }
};

const stored = <T>(project: Project, use: (store: RunStore) => T): Opened<T> => {
  const store = openStore(project.storeDir, project.clock);
  if (!store.ok) return store;
  try {
    return { ok: true, value: use(store.value) };
  } finally {
    store.value.close();
  }
};

// Applies the undo only when its fresh plan has the hash the client showed; the summary of the recorded undo run.
const undone = (store: RunStore, request: Parameters<typeof undo>[1]): RunSummary | Refusal => {
  const { run, refusal } = undo(store, request);
  if (refusal !== null) return refusal;
  const recorded = run === null ? undefined : store.run(run);
  if (recorded === undefined) throw new Error(`undo of ${request.run} recorded no run`);
  return summary(recorded);
};

/** GET /api/doctor and GET /api/runs: the checks of this installation and the project's runs, newest first. */
const reads = (app: FastifyInstance, project: Project): void => {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.get('/api/doctor', { schema: { response: { 200: BODIES.doctor, ...ERRORS } } }, async () => {
    const { report, findings } = doctor(project);
    return { ...report, findings };
  });
  routes.get('/api/runs', { schema: { response: { 200: BODIES.runs, ...ERRORS } } }, async (_req, reply) => {
    const runs = viewed(project, (view) => view.runs());
    return runs.ok ? { runs: runs.value } : refuse(reply, runs.refusal);
  });
  const show = { params: RunPath, response: { 200: BODIES.run, ...ERRORS } };
  routes.get('/api/runs/:id', { schema: show }, async ({ params: { id } }, reply) => {
    const run = viewed(project, (view) => view.run(id));
    if (!run.ok) return refuse(reply, run.refusal);
    return run.value ?? refuse(reply, { code: 'run.not-found', params: { run: id } });
  });
};

/** GET and POST /api/runs/{id}/undo: the undo plan, and its apply for the plan hash the client showed. */
const undoRoutes = (app: FastifyInstance, project: Project): void => {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const { root } = project;
  const preview = { params: RunPath, response: { 200: BODIES.preview, ...ERRORS } };
  routes.get('/api/runs/:id/undo', { schema: preview }, async ({ params: { id } }, reply) => {
    const planned = stored(project, (store) => planUndo(store, { root, run: id }));
    if (!planned.ok) return refuse(reply, planned.refusal);
    const { plan, refusal } = planned.value;
    if (plan !== null) return { planHash: plan.planHash, plan, refusals: [] };
    return refusal.code === 'run.not-found'
      ? refuse(reply, refusal)
      : { planHash: null, plan: null, refusals: [refusal] };
  });
  const apply = { params: RunPath, body: BODIES.apply, response: { 200: BODIES.applied, ...ERRORS } };
  routes.post('/api/runs/:id/undo', { schema: apply }, async ({ params: { id }, body }, reply) => {
    const done = stored(project, (store) => undone(store, { root, run: id, planHash: body.planHash }));
    if (!done.ok) return refuse(reply, done.refusal);
    return 'code' in done.value ? refuse(reply, done.value) : { run: done.value };
  });
};

/** The routes over the project's runs and the doctor checks. */
export const apiRoutes = (app: FastifyInstance, project: Project): void => {
  reads(app, project);
  undoRoutes(app, project);
};
