import { readFileSync } from 'node:fs';
import type { Finding } from '@cedarloom/core';
import type { z } from 'zod';
import { errorCode } from './project-files.ts';

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
    // ENOTDIR: a folder on the way is a file.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { value: undefined };
    // A folder, a link loop, or a file or folder the app may not read.
    if (code === 'EISDIR' || code === 'ELOOP' || code === 'EACCES' || code === 'EPERM') return { finding: unknown };
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
