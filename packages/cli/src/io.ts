import type { StoreClock } from '@cedarloom/use-cases';

/** What a command takes from its process; tests pass their own. */
export interface Io {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  realpath: (path: string) => string;
  /** The running Node.js version. */
  node: string;
  /** The package's version and its engines.node range. */
  version: string;
  required: string;
  clock: StoreClock;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}
