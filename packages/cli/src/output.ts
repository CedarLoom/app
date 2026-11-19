import type { Finding, Refusal } from '@cedarloom/core';
import type { Io } from './io.ts';
import { message, printable } from './message.ts';

/** How a command ended: its --json document, and its result as text for text mode. */
export interface Outcome {
  result: unknown;
  findings: Finding[];
  refusals: Refusal[];
  text: string;
}

export const refused = (refusal: Refusal, findings: Finding[] = []): Outcome => ({
  result: null,
  findings,
  refusals: [refusal],
  text: '',
});

// The two cli codes that are no usage error.
const NOT_USAGE = new Set(['cli.confirm-required', 'cli.internal']);
const isUsage = (code: string): boolean => code.startsWith('cli.') && !NOT_USAGE.has(code);

/** The exit code: 5 for a crash; else 2 for usage, 3 for a refusal, 1 for a failed check, 4 for a plan not applied. */
export const exitCode = ({ findings, refusals }: Outcome): number => {
  const codes = refusals.map(({ code }) => code);
  if (codes.includes('cli.internal')) return 5;
  if (codes.some(isUsage)) return 2;
  if (codes.some((code) => !NOT_USAGE.has(code))) return 3;
  if (findings.some(({ severity }) => severity === 'error')) return 1;
  return codes.length === 0 ? 0 : 4;
};

/** Results on standard output and messages on standard error; with --json, the one document alone. */
export const write = ({ result, findings, refusals, text }: Outcome, json: boolean, io: Io): void => {
  if (json) {
    io.stdout(`${JSON.stringify({ result, findings, refusals })}\n`);
    return;
  }
  io.stdout(text);
  for (const { code, params } of [...findings, ...refusals]) io.stderr(`${message(code, params)}\n`);
};

/** Rows as aligned text columns, each cell printable. */
export const columns = (rows: readonly (readonly string[])[]): string => {
  const cells = rows.map((row) => row.map(printable));
  const widths = cells.reduce<number[]>(
    (found, row) => row.map((cell, index) => Math.max(found[index] ?? 0, cell.length)),
    [],
  );
  return cells
    .map(
      (row) =>
        `${row
          .map((cell, index) => cell.padEnd(widths[index] ?? 0))
          .join('  ')
          .trimEnd()}\n`,
    )
    .join('');
};
