import type { Refusal } from '@cedarloom/core';
import { openStore, projectRoot, type RunStore, storeDir } from '@cedarloom/use-cases';
import type { Io } from './io.ts';
import { type Outcome, refused } from './output.ts';

/** The project of the working directory and the folder of its store. */
export const locate = (io: Io): { root: string; dir: string } | { refusal: Refusal } => {
  const root = projectRoot(io.cwd);
  if (typeof root !== 'string') return { refusal: root };
  return { root, dir: storeDir({ ...io, projectRoot: root }) };
};

/** Runs work on the project's store, held for the call; refused when there is no project or the store cannot open. */
export const withStore = (io: Io, work: (store: RunStore, root: string) => Outcome): Outcome => {
  const place = locate(io);
  if ('refusal' in place) return refused(place.refusal);
  const store = openStore(place.dir, io.clock);
  if (!store.ok) return refused(store.refusal);
  try {
    return work(store.value, place.root);
  } finally {
    store.value.close();
  }
};
