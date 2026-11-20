// Store, plan and child-process fixtures of the apply, undo and recovery tests. Each folder and store they make is
// removed or closed after each test.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanOperation, Refusal } from '@cedarloom/core';
import { afterEach, expect } from 'vitest';
import type { Applied, ApplyRequest, Boundary } from './apply.ts';
import { openRunView, openStore, type RunStore, type RunView, type StoreClock } from './store.ts';
import type { UndoRequest } from './undo.ts';

const folders: string[] = [];
const opened: { close(): void }[] = [];
afterEach(() => {
  for (const item of opened.splice(0)) item.close();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cedarloom-apply-'));
  folders.push(dir);
  return dir;
};

// A project with `.claude/` holding these files, and a store folder beside it.
export const project = (files: Record<string, string> = {}): { root: string; state: string } => {
  const root = fresh();
  mkdirSync(join(root, '.claude'));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return { root, state: fresh() };
};

export const storeWith = (state: string, clock: StoreClock): RunStore => {
  const result = openStore(state, clock);
  if (!result.ok) throw new Error(result.refusal.code);
  opened.push(result.value);
  return result.value;
};

// The store gives the run ids in order, then r1.
export const store = (state: string, ...ids: string[]): RunStore =>
  storeWith(state, { now: () => new Date('2026-11-18T22:17:39.123Z'), newRunId: () => ids.shift() ?? 'r1' });

// Releases a store before another process takes it.
export const release = (held: RunStore): void => {
  opened.splice(opened.indexOf(held), 1);
  held.close();
};

export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export const create = (path: string, after: string, afterHash = hash(after)): PlanOperation => ({
  kind: 'create',
  path,
  beforeHash: null,
  afterHash,
  before: null,
  after,
});
export const replace = (path: string, before: string, after: string): PlanOperation => ({
  kind: 'replace',
  path,
  beforeHash: hash(before),
  afterHash: hash(after),
  before,
  after,
});
export const remove = (path: string, before: string): PlanOperation => ({
  kind: 'delete',
  path,
  beforeHash: hash(before),
  afterHash: null,
  before,
  after: null,
});

export const request = (root: string, operations: PlanOperation[]): ApplyRequest => ({
  root,
  plan: { planHash: 'a'.repeat(64), operations, skipped: [] },
  run: { kind: 'apply', action: 'workflow.new', subject: 'demo', undoes: null, generatedFrom: [] },
});

// A run recorded as running whose one step never started: a create at `path`, or a replace of the file hashed `before`.
export const begin = (held: RunStore, root: string, path: string, before?: string): void => {
  const afterHash = hash('a\n');
  const operation =
    before === undefined
      ? ({ kind: 'create', path, beforeHash: null, afterHash, entries: null } as const)
      : ({ kind: 'replace', path, beforeHash: before, afterHash, entries: null } as const);
  held.begin({ ...request(root, []).run, planHash: 'a'.repeat(64), operations: [operation] });
};

const view = (state: string): RunView => {
  const opening = openRunView(state);
  if (!opening.ok) throw new Error(opening.refusal.code);
  opened.push(opening.value);
  return opening.value;
};

export const run = (state: string, id: string) => {
  const found = view(state).run(id);
  if (!found.ok || found.value === undefined) throw new Error(`no run ${id}`);
  return { status: found.value.status, steps: found.value.operations.map((operation) => operation.status) };
};

export const runs = (state: string): string[] => {
  const found = view(state).runs();
  if (!found.ok) throw new Error(found.refusal.code);
  return found.value.map((summary) => summary.status);
};

export const undone = (state: string, id: string): string | null => {
  const found = view(state).run(id);
  if (!found.ok || found.value === undefined) throw new Error(`no run ${id}`);
  return found.value.undoneBy;
};

export const text = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);
export const listing = (root: string): string[] => readdirSync(join(root, '.claude')).toSorted();
export const refused = (refusal: Refusal, id: string | null = null): Applied => ({ run: id, refusal, findings: [] });
export const recovered = (path: string, id = 'r1') => ({
  code: 'apply.recovered',
  severity: 'info',
  params: { run: id, path },
});
export const refusedAt = (code: Refusal['code'], path: string, id: string | null = null): Applied =>
  refused({ code, params: { path } }, id);

// What `act` throws.
export const thrownBy = (act: () => unknown): unknown => {
  try {
    act();
  } catch (error) {
    return error;
  }
  return undefined;
};

// A step hook that throws at `boundary` of the operation at `position`, as a disk failing there.
export const failAt =
  (boundary: Boundary, position: number) =>
  (at: Boundary, index: number): void => {
    if (at === boundary && index === position) throw new Error('disk gone');
  };

// Another process that applies the plan as run r1, or undoes the run as run u1, and kills itself at `boundary` of the
// operation at `position`.
export const crash = async (
  state: string,
  plan: ApplyRequest | UndoRequest,
  boundary: Boundary,
  position: number,
): Promise<void> => {
  const script = `
    import { apply } from ${JSON.stringify(new URL('apply.ts', import.meta.url).href)};
    import { undo } from ${JSON.stringify(new URL('undo.ts', import.meta.url).href)};
    import { openStore } from ${JSON.stringify(new URL('store.ts', import.meta.url).href)};
    const [state, plan, boundary, position] = process.argv.slice(1);
    const request = JSON.parse(plan);
    const id = 'plan' in request ? 'r1' : 'u1';
    const store = openStore(state, { now: () => new Date('2026-11-18T22:00:00.000Z'), newRunId: () => id });
    if (!store.ok) throw new Error(store.refusal.code);
    ('plan' in request ? apply : undo)(store.value, request, (at, index) => {
      if (at === boundary && index === Number(position)) process.kill(process.pid, 'SIGKILL');
    });
    process.stdout.write('not killed');
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', script, state, JSON.stringify(plan), boundary, String(position)],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  await once(child, 'exit');
  expect(out).toBe('');
};
