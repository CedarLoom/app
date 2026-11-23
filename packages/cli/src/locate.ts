import type { Refusal } from '@cedarloom/core';
import { openStore, projectRoot, type RunStore, storeDir } from '@cedarloom/use-cases';
import type { Io } from './io.ts';
import { type Outcome, refused } from './output.ts';

/** The project of the working directory and the folder of its store. */
export const locate = (io: Io): { root: string; dir: string } | { refusal: Refusal } => {
  const root = projectRoot(io.cwd);
  if (typeof root !== 'string') return { refusal: root };
  try {
    return { root, dir: storeDir({ ...io, projectRoot: root }) };
  } catch (error) {
    // A system error on the real path (syscall set) is a refusal; anything else, an argument error included, is a crash.
    if (error instanceof Error && 'syscall' in error)
      return { refusal: { code: 'project.path-unresolvable', params: { path: root } } };
    throw error;
  }
};

/**
 * Runs work on the project's store, held for the call; refused when there is no project, with `stop` once the project
 * is found, or when the store cannot open.
 */
export const withStore = (io: Io, work: (store: RunStore, root: string) => Outcome, stop?: Refusal): Outcome => {
  const place = locate(io);
  if ('refusal' in place) return refused(place.refusal);
  if (stop !== undefined) return refused(stop);
  const store = openStore(place.dir, io.clock);
  if (!store.ok) return refused(store.refusal);
  try {
    return work(store.value, place.root);
  } finally {
    store.value.close();
  }
};
