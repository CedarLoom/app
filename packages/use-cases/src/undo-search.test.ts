import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Refusal, Run } from '@cedarloom/core';
import { describe, expect, it } from 'vitest';
import { type At, apply, type Boundary, StepFailed } from './apply.ts';
import {
  create,
  failAt,
  hash,
  listing,
  project,
  replace,
  request,
  run,
  store,
  text,
  thrownBy,
} from './test-fixtures.ts';
import { undo } from './undo.ts';

const PATHS = ['.claude/a.md', '.claude/b.md'];
// Two steps on b.md around a create of a.md.
const PLAN = [
  replace('.claude/b.md', 'A\n', 'B\n'),
  create('.claude/a.md', 'a\n'),
  replace('.claude/b.md', 'B\n', 'C\n'),
];
const HISTORIES = 2;
const DEPTH = 6;

// Another process writes `content` to b.md at `boundary` of the step at `position`, so the run fails there.
const race =
  (boundary: Boundary, position: number, content = 'theirs\n') =>
  (root: string): At =>
  (at, index) => {
    if (at === boundary && index === position) writeFileSync(join(root, '.claude/b.md'), content);
  };

type Tally = Record<string, number>;

interface FirstRun {
  name: string;
  /** The step hook r1 applies PLAN with. */
  ending: (root: string) => At;
  status: Run['status'];
  /** The seed its histories are drawn from. */
  seed: number;
  /** How often each outcome came up in its histories; "nested" ones came after an unfinished undo and a later done one. */
  tally: Tally;
}

const FIRST_RUNS: FirstRun[] = [
  {
    name: 'finishes',
    ending: () => () => undefined,
    status: 'done',
    seed: 27,
    tally: { done: 8, 'nested done': 3, 'nested stopped': 1, stopped: 2, 'undo.replaced': 2 },
  },
  {
    name: 'stops after its first write',
    ending: () => failAt('written', 0),
    status: 'interrupted',
    seed: 1027,
    tally: {
      done: 7,
      'nested done': 5,
      'nested run.already-undone': 1,
      'nested undo.result-kept': 1,
      'run.already-undone': 1,
      stopped: 2,
      'undo.result-kept': 1,
    },
  },
  {
    name: 'stops before its last write',
    ending: () => failAt('temp-written', 2),
    status: 'interrupted',
    seed: 2018,
    tally: { done: 6, 'nested run.already-undone': 2, 'run.already-undone': 2, stopped: 2, 'undo.replaced': 1 },
  },
  {
    name: 'fails at a file written before its first set-aside',
    ending: race('temp-written', 0),
    status: 'failed',
    seed: 3011,
    tally: { done: 7, 'run.already-undone': 3, 'undo.replaced': 1 },
  },
  {
    name: 'fails at a file written after its last set-aside',
    ending: race('set-aside', 2),
    status: 'failed',
    seed: 4001,
    tally: {
      done: 5,
      'nested done': 1,
      'nested run.already-undone': 1,
      'run.already-undone': 1,
      stopped: 1,
      'undo.file-changed': 3,
    },
  },
  {
    name: 'fails at its own result written after its last set-aside',
    ending: race('set-aside', 2, 'C\n'),
    status: 'failed',
    seed: 5025,
    tally: {
      done: 3,
      'nested done': 1,
      'nested run.already-undone': 3,
      'nested undo.file-changed': 1,
      'run.already-undone': 3,
      stopped: 2,
      'undo.file-changed': 1,
    },
  },
];

interface Recorded {
  id: string;
  undoes: string | null;
  done: boolean;
}

// A run is in effect while no done undo of it is in effect.
const inEffect = (runs: Recorded[], id: string): boolean =>
  !runs.some((other) => other.undoes === id && other.done && inEffect(runs, other.id));
const undoneBy = (runs: Recorded[], id: string): string | null =>
  runs.findLast((other) => other.undoes === id && other.done)?.id ?? null;
const chainBelow = (runs: Recorded[], id: string): string[] => {
  const below = runs.find((other) => other.id === id)?.undoes;
  return below ? [below, ...chainBelow(runs, below)] : [];
};
// An unfinished undo with a done undo recorded after it.
const nestedIn = (runs: Recorded[]): boolean =>
  runs.some((r, at) => r.undoes !== null && !r.done && runs.slice(at + 1).some((later) => later.done));

// Each path's text hash, null for no file.
const hashes = (root: string): Map<string, string | null> =>
  new Map(
    PATHS.map((path) => {
      const content = text(join(root, path));
      return [path, content === null ? null : hash(content)];
    }),
  );

interface History {
  root: string;
  state: string;
  held: ReturnType<typeof store>;
  runs: Recorded[];
  label: string;
}

// The run an undo targets, as its journal and the files before the undo show it.
interface Target {
  id: string;
  started: Run['operations'];
  before: Map<string, string | null>;
  /** The paths of its started steps that hold a text none of them found or left. */
  foreign: string[];
  effect: boolean;
}

const targetOf = ({ root, held, runs }: History, id: string): Target => {
  const started = (held.run(id)?.operations ?? []).filter((op) => !['pending', 'untouched'].includes(op.status));
  const before = hashes(root);
  const foreign = [...new Set(started.map((op) => op.path))].filter(
    (path) =>
      !started
        .flatMap((op) => (op.path === path ? [op.beforeHash, op.afterHash] : []))
        .includes(before.get(path) ?? null),
  );
  return { id, started, before, foreign, effect: inEffect(runs, id) };
};

const checkStopped = ({ state, runs, label }: History, target: Target, thrown: unknown): string => {
  if (!(thrown instanceof StepFailed)) throw thrown;
  expect(run(state, thrown.run).status, label).toBe('interrupted');
  runs.push({ id: thrown.run, undoes: target.id, done: false });
  return 'stopped';
};

// Each path the target touched is back as before the target's first started step on it.
const checkDone = ({ root, state, runs, label }: History, target: Target, id: string): string => {
  expect([target.effect, target.foreign], label).toEqual([true, []]);
  const after = hashes(root);
  for (const path of PATHS) {
    const first = target.started.find((op) => op.path === path);
    if (first !== undefined) expect(after.get(path), `${label}: ${path}`).toBe(first.beforeHash);
  }
  expect(run(state, id).status, label).toBe('done');
  runs.push({ id, undoes: target.id, done: true });
  return 'done';
};

// A refusal changes no file, and names what the journal and the files show.
const checkRefused = ({ root, held, runs, label }: History, target: Target, { code, params }: Refusal): string => {
  expect(hashes(root), label).toEqual(target.before);
  const { path, run: named, by } = params as { path?: string; run?: string; by?: string };
  if (!target.effect) {
    expect({ code, params }, label).toEqual({
      code: 'run.already-undone',
      params: { run: target.id, by: undoneBy(runs, target.id) },
    });
  } else if (code === 'undo.file-changed') {
    expect(target.foreign, label).toContain(path);
  } else if (code === 'undo.result-kept') {
    // The path holds a text the named run left there.
    const left = held.run(String(named))?.operations.filter((op) => op.path === path);
    expect(
      left?.map((op) => op.afterHash),
      label,
    ).toContain(target.before.get(String(path)));
  } else {
    // The run named sits below the target in its chain, and the undo named is its newest done one.
    expect(['run.already-undone', 'undo.replaced'], label).toContain(code);
    expect([chainBelow(runs, target.id), by], label).toEqual([
      expect.arrayContaining([named]),
      undoneBy(runs, String(named)),
    ]);
  }
  return code;
};

// Undoes the target, stopped after its first write when `stop`, and checks the outcome; gives it as done, stopped or
// the refusal code. No path the target's started steps did not touch changes, and no temporary or aside file stays.
const checkedUndo = (history: History, id: string, stop: boolean): string => {
  const { root, held, label } = history;
  const target = targetOf(history, id);
  let undone: ReturnType<typeof undo> | undefined;
  const thrown = thrownBy(() => {
    undone = undo(held, { root, run: id }, stop ? failAt('written', 0) : undefined);
  });
  expect(
    listing(root).filter((name) => !['a.md', 'b.md'].includes(name)),
    label,
  ).toEqual([]);
  const touched = new Set(target.started.map((op) => op.path));
  const after = hashes(root);
  for (const path of PATHS.filter((p) => !touched.has(p))) expect(after.get(path), label).toBe(target.before.get(path));
  if (undone === undefined) {
    expect(stop, label).toBe(true);
    return checkStopped(history, target, thrown);
  }
  if (undone.refusal !== null) {
    expect(undone.run, label).toBeNull();
    return checkRefused(history, target, undone.refusal);
  }
  return checkDone(history, target, String(undone.run));
};

// Mostly an undo of a run in effect, done or stopped after its first write; now and then an undo of any run, or b.md
// put back by hand (null).
const drawAction = (runs: Recorded[], draw: () => number): { id: string; stop: boolean } | null => {
  const kind = draw() % 8;
  if (kind === 7) return null;
  const pool = kind === 6 ? runs : runs.filter((r) => inEffect(runs, r.id));
  return { id: pool[draw() % pool.length]?.id ?? 'r1', stop: kind === 4 || kind === 5 };
};

// r1 applies PLAN and ends as `first` says, then DEPTH drawn actions follow, each undo checked.
const history = ({ name, ending, status }: FirstRun, draw: () => number, tally: Tally): void => {
  const { root, state } = project({ '.claude/b.md': 'A\n' });
  const held = store(state, 'r1', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6');
  thrownBy(() => apply(held, request(root, PLAN), ending(root)));
  expect(run(state, 'r1').status, name).toBe(status);
  const runs: Recorded[] = [{ id: 'r1', undoes: null, done: status === 'done' }];
  const steps: string[] = [];
  for (let depth = 0; depth < DEPTH; depth += 1) {
    const action = drawAction(runs, draw);
    if (action === null) writeFileSync(join(root, '.claude/b.md'), 'A\n');
    steps.push(action === null ? 'b.md put back' : `${action.stop ? 'stopped undo' : 'undo'} of ${action.id}`);
    if (action === null) continue;
    const nested = nestedIn(runs);
    const label = `r1 ${name}, then ${steps.join(', ')}`;
    const outcome = checkedUndo({ root, state, held, runs, label }, action.id, action.stop);
    for (const key of nested ? [outcome, `nested ${outcome}`] : [outcome]) tally[key] = (tally[key] ?? 0) + 1;
  }
};

describe('undo over a search of run histories', () => {
  it.each(FIRST_RUNS)('keeps its rules after r1 $name', (first) => {
    // A Lehmer generator from a fixed seed, so each run of the test walks the same histories.
    let next = first.seed;
    const draw = (): number => (next = (next * 48_271) % 2_147_483_647);
    const tally: Tally = {};
    for (let n = 0; n < HISTORIES; n += 1) history(first, draw, tally);
    expect(tally).toEqual(first.tally);
  });
});
