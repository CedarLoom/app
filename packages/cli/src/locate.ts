import type { Refusal } from '@cedarloom/core';
import { projectRoot, storeDir } from '@cedarloom/use-cases';
import type { Io } from './io.ts';

/** The project of the working directory and the folder of its store. */
export const locate = (io: Io): { root: string; dir: string } | { refusal: Refusal } => {
  const root = projectRoot(io.cwd);
  if (root === undefined) return { refusal: { code: 'project.not-found', params: { cwd: io.cwd } } };
  return { root, dir: storeDir({ ...io, projectRoot: root }) };
};
