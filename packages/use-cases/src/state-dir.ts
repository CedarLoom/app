import { posix, win32 } from 'node:path';

export interface StateDirInputs {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  home: string;
  cwd: string;
}

/** The state folder: CEDARLOOM_STATE_DIR, else `cedarloom` in XDG_STATE_HOME, else in the platform's default folder. */
export const stateDir = ({ env, platform, home, cwd }: StateDirInputs): string => {
  const path = platform === 'win32' ? win32 : posix;
  const own = env['CEDARLOOM_STATE_DIR'];
  if (own) return path.resolve(cwd, own);
  // XDG Base Directory: an empty value counts as unset, and a relative one is invalid and ignored.
  const xdg = env['XDG_STATE_HOME'];
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'cedarloom');
  if (platform !== 'win32') return path.join(home, '.local', 'state', 'cedarloom');
  // LOCALAPPDATA follows a relocated local application data folder; the home path is its default place.
  const local = env['LOCALAPPDATA'];
  return path.join(local && path.isAbsolute(local) ? local : path.join(home, 'AppData', 'Local'), 'cedarloom');
};
