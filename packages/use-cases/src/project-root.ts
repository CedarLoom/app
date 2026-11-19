import { dirname, join, resolve } from 'node:path';
import { entryAt } from './project-files.ts';

/** The top folder of the Git working tree that holds cwd, by its .git entry; no git process, so no git setting moves it. */
export const projectRoot = (cwd: string): string | undefined => {
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    if (entryAt(join(folder, '.git')) !== undefined) return folder;
    if (dirname(folder) === folder) return undefined;
  }
};
