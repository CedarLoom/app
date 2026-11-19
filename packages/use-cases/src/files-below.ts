import { type Dirent, readdirSync } from 'node:fs';
import { join } from 'node:path';

const entriesOf = (path: string): Dirent[] => readdirSync(path, { withFileTypes: true });

/**
 * The regular files below folder, by their paths relative to it with "/" as separator, each folder listed by list;
 * links are not followed.
 */
export const filesBelow = (folder: string, list = entriesOf, below = ''): string[] =>
  // Walked folder by folder: a recursive readdirSync descends into linked folders.
  list(join(folder, below)).flatMap((entry) => {
    const path = below === '' ? entry.name : `${below}/${entry.name}`;
    if (entry.isDirectory()) return filesBelow(folder, list, path);
    return entry.isFile() ? [path] : [];
  });
