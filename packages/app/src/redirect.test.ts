import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeRedirect } from './redirect.ts';

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const parent = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'cedarloom-redirect-'));
  folders.push(path);
  return join(path, 'state');
};

describe('writeRedirect', () => {
  it.skipIf(process.platform === 'win32')(
    'writes the page as 0600 into a new 0700 folder (POSIX modes; Windows has the profile ACL instead)',
    () => {
      const { path } = writeRedirect(parent(), 'http://127.0.0.1:4000/#t=abc');
      expect([statSync(dirname(path)).mode & 0o777, statSync(path).mode & 0o777]).toEqual([0o700, 0o600]);
    },
  );

  it('holds the URL in its refresh and in its link', () => {
    const page = readFileSync(writeRedirect(parent(), 'http://127.0.0.1:4000/#t=abc').path, 'utf8');
    expect(page).toContain('<meta http-equiv="refresh" content="0;url=http://127.0.0.1:4000/#t=abc">');
    expect(page).toContain('<a href="http://127.0.0.1:4000/#t=abc">');
  });
});
