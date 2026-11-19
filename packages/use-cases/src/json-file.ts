import { readFileSync } from 'node:fs';
import type { Finding } from '@cedarloom/core';
import type { z } from 'zod';

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** A JSON file read with its schema: no value when the file does not exist, the given finding when its text or shape is unknown. */
export const jsonFile = <T>(
  path: string,
  schema: z.ZodType<T>,
  unknown: Finding,
): { value: T | undefined } | { finding: Finding } => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { value: undefined };
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
