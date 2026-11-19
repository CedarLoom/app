import { win32 } from 'node:path';

interface Opener {
  command: string;
  args: string[];
}

/** The platform's own opener for a file; on Windows the arguments reach cmd verbatim. */
export const opener = (platform: NodeJS.Platform, systemRoot: string | undefined, path: string): Opener => {
  if (platform === 'darwin') return { command: 'open', args: [path] };
  if (platform !== 'win32') return { command: 'xdg-open', args: [path] };
  // cmd by its full path: Windows looks for a bare name in the working directory, the project, before PATH.
  // start takes its first quoted word as a window title, hence the empty one; quotes keep a path with spaces whole.
  const command = win32.join(systemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return { command, args: ['/c', 'start', '""', `"${path}"`] };
};
