import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { JsonValue, type Refusal } from '@cedarloom/core';
import { z } from 'zod';
import { cut, jsonOf } from './generator-run.ts';
import { nestsBeyond } from './json-nesting.ts';
import { isUnreachable, reached } from './plugin-folder.ts';
import { errorCode, readFound } from './project-files.ts';
import { blockOnWay } from './write-roots.ts';

/** The folder of a project's definitions, relative to the project root. */
export const PROJECT_FOLDER = '.cedarloom/workflows';
/** The folder of a plugin's shipped definitions, relative to the plugin root. */
export const SHIPPED_FOLDER = 'definitions';
// Far above a written definition, and far below the 2 GiB Node.js reads into one buffer.
const SIZE_LIMIT = 16 * 1024 * 1024;
// zod's JSON schema and the "__proto__" check recurse once per level, so a deeper file could overflow the stack.
const NESTING_LIMIT = 100;
export const Named = z.object({ name: z.string() });

/** The refusal of a definition text the definition readers would not read, with their limits. */
export const overLimits: Refusal = {
  code: 'edit.result-over-limits',
  params: { mebibytes: SIZE_LIMIT / (1024 * 1024), levels: NESTING_LIMIT },
};

/**
 * The refusal of a definition whose name field is not its file name without `.json`: the generator writes the outputs
 * under the name field, while a named run finds its definition, and the outputs it deletes, by the file name. A name
 * that is no string shows as its JSON.
 */
export const nameMismatch = (file: string, json: unknown): Refusal | undefined => {
  if (typeof json !== 'object' || json === null || !('name' in json)) return undefined;
  const { name } = json;
  if (name === basename(file, '.json')) return undefined;
  const shown = typeof name === 'string' ? name : JSON.stringify(name);
  return { code: 'definition.name-mismatch', params: { file, name: cut(shown) } };
};

/** A folder's `*.json` files without dotfiles (an editor's lock link); unreadable when out of reach or behind a link. */
export const definitionFileNames = (base: string, folder: string): string[] | 'unreadable' => {
  // A folder reached through a link may lie elsewhere, as a definition file that is a link may.
  if (blockOnWay(base, folder) !== undefined) return 'unreadable';
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
 * Whether the folder lists the definition file at a "/"-separated path below base by exactly that spelling, so a
 * case-insensitive volume finds no build.json beside Build.json, as a case-sensitive one does not. True when the folder
 * is unreadable, for the reader to refuse.
 */
export const isListed = (base: string, path: string): boolean => {
  const slash = path.lastIndexOf('/');
  const files = definitionFileNames(base, path.slice(0, slash));
  return files === 'unreadable' || files.includes(path.slice(slash + 1));
};

/**
 * The bytes of the definition file at a "/"-separated path below base; unreadable when it is a link, a folder, a FIFO,
 * a socket, out of reach, larger than any reader takes or nested deeper.
 */
export const definitionBytes = (base: string, path: string): Buffer | 'absent' | 'unreadable' => {
  // Where Node.js has no O_NOFOLLOW, as on Windows, readFound alone would follow a link.
  if (blockOnWay(base, path) !== undefined) return 'unreadable';
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

/**
 * JSON text as a value, as the definition readers read it; undefined for text they refuse. JsonValue also refuses a
 * __proto__ member.
 */
export const jsonWithin = (text: string): JsonValue | undefined => {
  const bytes = Buffer.from(text);
  if (bytes.length > SIZE_LIMIT || nestsBeyond(bytes, NESTING_LIMIT)) return undefined;
  const parsed = JsonValue.safeParse(jsonOf(text));
  return parsed.success ? parsed.data : undefined;
};
