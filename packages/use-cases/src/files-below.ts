import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The regular files below folder, by their paths relative to it with "/" as separator; links are not followed. */
export const filesBelow = (folder: string, below = ''): string[] =>
  // Walked folder by folder: a recursive readdirSync descends into linked folders.
  readdirSync(join(folder, below), { withFileTypes: true }).flatMap((entry) => {
    const path = below === '' ? entry.name : `${below}/${entry.name}`;
    if (entry.isDirectory()) return filesBelow(folder, path);
    return entry.isFile() ? [path] : [];
  });
