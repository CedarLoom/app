import { describe, expect, it } from 'vitest';
import { opener } from './opener.ts';

describe('opener', () => {
  it('quotes a Windows path with spaces as one argument after the empty window title', () => {
    expect(
      opener('win32', 'C:\\Windows', 'C:\\Users\\Ann Lee\\AppData\\Local\\cedarloom\\open-x\\cedarloom-app.html'),
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/c', 'start', '""', '"C:\\Users\\Ann Lee\\AppData\\Local\\cedarloom\\open-x\\cedarloom-app.html"'],
    });
  });
});
