import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nestsBeyond } from './json-nesting.ts';
import { isUnreachable, reached } from './plugin-folder.ts';
import { errorCode, readFound } from './project-files.ts';
import { linkOnWay } from './write-roots.ts';

/** The folder of a project's definitions, relative to the project root. */
export const PROJECT_FOLDER = '.cedarloom/workflows';
/** The folder of a plugin's shipped definitions, relative to the plugin root. */
export const SHIPPED_FOLDER = 'definitions';
// Far above a written definition, and far below the 2 GiB Node.js reads into one buffer.
const SIZE_LIMIT = 16 * 1024 * 1024;
// zod's JSON schema and the "__proto__" check recurse once per level, so a deeper file could overflow the stack.
const NESTING_LIMIT = 100;

/** A folder's `*.json` files without dotfiles (an editor's lock link); unreadable when out of reach or behind a link. */
export const definitionFileNames = (base: string, folder: string): string[] | 'unreadable' => {
  // A folder reached through a link may lie elsewhere, as a definition file that is a link may.
  if (reached(() => linkOnWay(base, folder) ?? null) !== null) return 'unreadable';
  try {
    const files = readdirSync(join(base, folder)).filter((file) => file.endsWith('.json') && !file.startsWith('.'));
    return files.toSorted();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    if (isUnreachable(error)) return 'unreadable';
    throw error;
  }
};

/**
 * The bytes of the definition file at a "/"-separated path below base; unreadable when it is a link, a folder, a FIFO,
 * a socket, out of reach, larger than any reader takes or nested deeper.
 */
export const definitionBytes = (base: string, path: string): Buffer | 'absent' | 'unreadable' => {
  // Where Node.js has no O_NOFOLLOW, as on Windows, readFound alone would follow a link.
  if (reached(() => linkOnWay(base, path) ?? null) !== null) return 'unreadable';
  const found = reached(() => {
    try {
      return readFound(join(base, path), SIZE_LIMIT + 1);
    } catch (error) {
      // A name too long to exist names no file.
      if (errorCode(error) === 'ENAMETOOLONG') return 'absent';
      throw error;
    }
  });
  if (found === 'absent') return 'absent';
  if (typeof found !== 'object' || found.bytes.length > SIZE_LIMIT) return 'unreadable';
  return nestsBeyond(found.bytes, NESTING_LIMIT) ? 'unreadable' : found.bytes;
};
