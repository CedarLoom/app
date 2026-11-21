import {
  ApplyRefusal,
  type Code,
  DoctorResult,
  Finding,
  Refusal,
  Run,
  RunId,
  RunList,
  type RunSummary,
  UndoApplied,
  UndoApply,
  UndoPreview,
  WorkflowList,
  WorkflowName,
  WorkflowShown,
  WorkflowSource,
} from '@cedarloom/core';
import {
  type DoctorRequest,
  doctor,
  listWorkflows,
  type Opened,
  openRunView,
  openStore,
  planUndo,
  type RunStore,
  type RunView,
  type StoreClock,
  showWorkflow,
  undo,
} from '@cedarloom/use-cases';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/** What the API routes act on: the project the server started in, its store, and the inputs of the doctor checks. */
export interface Project extends DoctorRequest {
  root: string;
  storeDir: string;
  clock: StoreClock;
}

// Named components of the OpenAPI document, so the client generated from it names its types.
const BODIES = {
  doctor: DoctorResult.meta({ id: 'DoctorResult' }),
  runs: RunList.meta({ id: 'RunList' }),
  run: Run.meta({ id: 'Run' }),
  preview: UndoPreview.meta({ id: 'UndoPreview' }),
  apply: UndoApply.meta({ id: 'UndoApply' }),
  applied: UndoApplied.meta({ id: 'UndoApplied' }),
  workflows: WorkflowList.extend({ findings: z.array(Finding) }).meta({ id: 'WorkflowListResult' }),
  workflow: WorkflowShown.meta({ id: 'WorkflowShown' }),
  refusal: Refusal.meta({ id: 'Refusal' }),
  applyRefusal: ApplyRefusal.meta({ id: 'ApplyRefusal' }),
};

/** Every error body is a Refusal: the guard and the error handler can answer any route with one; a 500 may name a run. */
export const ERRORS = { '4xx': BODIES.refusal, '5xx': BODIES.applyRefusal } as const;
const RunPath = z.strictObject({ id: RunId });
// Both parameters are checked before either reaches a path. The router refuses a parameter over 100 characters first,
// so the document states that limit.
const DefinitionPath = z.strictObject({ source: WorkflowSource, name: WorkflowName.max(100) });

// A store this process cannot read, or of another version, is no conflict the client can resolve.
const STATUS: Partial<Record<Code, number>> = {
  'definition.not-found': 404,
  'run.not-found': 404,
  'store.unreadable': 500,
  'store.version-unsupported': 500,
};

const refuse = (reply: FastifyReply, refusal: ApplyRefusal): FastifyReply =>
  reply.code(STATUS[refusal.code] ?? 409).send(refusal);

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
const undone = (store: RunStore, request: Parameters<typeof undo>[1]): RunSummary | ApplyRefusal => {
  const { run, refusal } = undo(store, request);
  if (refusal !== null) return run === null ? refusal : { ...refusal, run };
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
  const apply = {
    params: RunPath,
    body: BODIES.apply,
    response: { 200: BODIES.applied, ...ERRORS, '4xx': BODIES.applyRefusal },
  };
  routes.post('/api/runs/:id/undo', { schema: apply }, async ({ params: { id }, body }, reply) => {
    const done = stored(project, (store) => undone(store, { root, run: id, planHash: body.planHash }));
    if (!done.ok) return refuse(reply, done.refusal);
    return 'code' in done.value ? refuse(reply, done.value) : { run: done.value };
  });
};

// A workflows verb that gives no result has stopped on at least one refusal; the first is the answer.
const firstOf = ({ refusals: [refusal] }: { refusals: Refusal[] }): Refusal => {
  if (refusal === undefined) throw new Error('a workflows verb gave neither a result nor a refusal');
  return refusal;
};

/** GET /api/workflows and GET /api/workflows/{source}/{name}: the shipped and project definitions, read only. */
const definitionRoutes = (app: FastifyInstance, project: Project): void => {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.get('/api/workflows', { schema: { response: { 200: BODIES.workflows, ...ERRORS } } }, async (_req, reply) => {
    const listed = listWorkflows(project);
    return listed.result === null ? refuse(reply, firstOf(listed)) : { ...listed.result, findings: listed.findings };
  });
  const show = { params: DefinitionPath, response: { 200: BODIES.workflow, ...ERRORS } };
  routes.get('/api/workflows/:source/:name', { schema: show }, async ({ params }, reply) => {
    const shown = showWorkflow(project, params.name, params.source === 'shipped');
    return shown.result ?? refuse(reply, firstOf(shown));
  });
};

/** The routes over the project's runs, its workflow definitions and the doctor checks. */
export const apiRoutes = (app: FastifyInstance, project: Project): void => {
  reads(app, project);
  undoRoutes(app, project);
  definitionRoutes(app, project);
};
