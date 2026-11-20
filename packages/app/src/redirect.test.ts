import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepRedirects, writeRedirect } from './redirect.ts';

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

// A folder with these files, changed at `seconds` since the epoch: 1000 is before the cut at 2000 s, 3000 after it.
const folder = (dir: string, files: Record<string, string>, seconds: number): void => {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  utimesSync(dir, seconds, seconds);
};

describe('sweepRedirects', () => {
  it('removes a redirect folder changed before the cut, keeps one changed after it and any other entry', () => {
    const state = parent();
    const page = { 'cedarloom-app.html': 'page' };
    folder(join(state, 'open-Old123'), page, 1000);
    folder(join(state, 'open-Emp456'), {}, 1000);
    folder(join(state, 'open-New789'), page, 3000);
    folder(join(state, 'store-Old123'), page, 1000);
    folder(join(state, 'open-Old1234'), page, 1000);
    folder(join(state, 'open-Odd123'), { 'cedarloom-app.html': 'page', 'note.txt': 'owner' }, 1000);
    writeFileSync(join(state, 'open-File12'), 'file');
    sweepRedirects(state, 2_000_000);
    expect(readdirSync(state).toSorted()).toEqual([
      'open-File12',
      'open-New789',
      'open-Odd123',
      'open-Old1234',
      'store-Old123',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'leaves a link of a redirect name, a folder whose page is a link, and what they point to (links need a privilege on Windows)',
    () => {
      const state = parent();
      const target = join(dirname(state), 'target');
      folder(target, { 'cedarloom-app.html': 'page' }, 1000);
      folder(state, {}, 3000);
      symlinkSync(target, join(state, 'open-Lnk123'));
      mkdirSync(join(state, 'open-Pgl123'));
      symlinkSync(join(target, 'cedarloom-app.html'), join(state, 'open-Pgl123', 'cedarloom-app.html'));
      utimesSync(join(state, 'open-Pgl123'), 1000, 1000);
      sweepRedirects(state, 2_000_000);
      expect([readdirSync(state).toSorted(), readdirSync(target)]).toEqual([
        ['open-Lnk123', 'open-Pgl123'],
        ['cedarloom-app.html'],
      ]);
    },
  );

  it('does nothing when the state folder does not exist yet', () => {
    expect(() => sweepRedirects(parent(), 2_000_000)).not.toThrow();
  });
});
