import { readFileSync } from 'node:fs';
import type { Finding } from '@cedarloom/core';
import type { z } from 'zod';
import { errorCode } from './project-files.ts';

// ENOTDIR: a folder on the way is a file; ENAMETOOLONG: a name too long to exist.
const ABSENT = new Set<unknown>(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG']);
// A folder, a link loop, or a file or folder the app may not read.
const UNREADABLE = new Set<unknown>(['EISDIR', 'ELOOP', 'EACCES', 'EPERM']);

/** A JSON file read with its schema: no value when the file does not exist, the given finding when it cannot be read or its text or shape is unknown. */
export const jsonFile = <T>(
  path: string,
  schema: z.ZodType<T>,
  unknown: Finding,
): { value: T | undefined } | { finding: Finding } => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    if (ABSENT.has(code)) return { value: undefined };
    if (UNREADABLE.has(code)) return { finding: unknown };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { finding: unknown };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { value: parsed.data } : { finding: unknown };
};
