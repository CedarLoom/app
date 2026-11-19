import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The regular files below folder, by their paths relative to it with "/" as separator; links are not followed. */
export const filesBelow = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join('/'));
