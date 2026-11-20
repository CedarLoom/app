import { type Run, RunId } from '@cedarloom/core';
import { openRunView, type RunView } from '@cedarloom/use-cases';
import type { Io } from './io.ts';
import { locate } from './locate.ts';
import { message } from './message.ts';
import { columns, type Outcome, refused } from './output.ts';

// Reads the store of the working directory's project; a missing store reads as one with no runs.
const read = (io: Io, reader: (view: RunView) => Outcome): Outcome => {
  const place = locate(io);
  if ('refusal' in place) return refused(place.refusal);
  const view = openRunView(place.dir);
  if (!view.ok) return refused(view.refusal);
  try {
    return reader(view.value);
  } finally {
    view.value.close();
  }
};

/** cedarloom runs list: the runs, newest first. */
export const runsList = (io: Io): Outcome =>
  read(io, (view) => {
    const runs = view.runs();
    if (!runs.ok) return refused(runs.refusal);
    const rows = runs.value.map(({ id, status, action, subject, startedAt }) => [
      id,
      status,
      action,
      subject ?? '',
      startedAt,
    ]);
    const text = rows.length === 0 ? `${message('output.runs-none')}\n` : columns(rows);
    return { result: { runs: runs.value }, findings: [], refusals: [], text };
  });

const runText = (run: Run): string => {
  const fields = (
    ['id', 'kind', 'action', 'subject', 'status', 'startedAt', 'endedAt', 'undoes', 'undoneBy'] as const
  ).map((field) => [field, run[field] ?? '']);
  const steps = run.operations.map(({ status, kind, path }) => [status, kind, path]);
  return `${columns(fields)}${steps.length === 0 ? '' : `\n${columns(steps)}`}`;
};

/** cedarloom runs show <run>: a run with its steps. */
export const runsShow = (io: Io, id: string): Outcome => {
  const notFound = refused({ code: 'run.not-found', params: { run: id } });
  return read(io, (view) => {
    // An id outside the run id form names no run, and is never looked up; the project is checked first.
    if (!RunId.safeParse(id).success) return notFound;
    const run = view.run(id);
    if (!run.ok) return refused(run.refusal);
    if (run.value === undefined) return notFound;
    return { result: run.value, findings: [], refusals: [], text: runText(run.value) };
  });
};
