import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Redirect, sweepRedirects, writeRedirect } from './redirect.ts';

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

// A folder holding a page as writeRedirect writes it, moved to `dir` and changed at `seconds` since the epoch.
const written = (dir: string, seconds: number): string => {
  renameSync(dirname(writeRedirect(dirname(dir), 'http://127.0.0.1:4000/#t=abc').path), dir);
  utimesSync(dir, seconds, seconds);
  return join(dir, 'cedarloom-app.html');
};

// A page of another state folder, so the sweeps of these tests have no own folder to skip.
const elsewhere = (): Redirect => writeRedirect(parent(), 'http://127.0.0.1:4000/#t=own');

describe('sweepRedirects', () => {
  it('removes a folder with a page this app wrote changed before the cut; keeps any other folder or entry', () => {
    const state = parent();
    written(join(state, 'open-Old123'), 1000);
    written(join(state, 'open-New789'), 3000);
    written(join(state, 'store-Old123'), 1000);
    written(join(state, 'open-Old1234'), 1000);
    written(join(state, 'open-Odd123'), 1000);
    writeFileSync(join(state, 'open-Odd123', 'note.txt'), 'owner');
    utimesSync(join(state, 'open-Odd123'), 1000, 1000);
    folder(join(state, 'open-Emp456'), {}, 1000);
    writeFileSync(join(state, 'open-File12'), 'file');
    expect([sweepRedirects(state, 2_000_000, elsewhere()), readdirSync(state).toSorted()]).toEqual([
      [],
      ['open-Emp456', 'open-File12', 'open-New789', 'open-Odd123', 'open-Old1234', 'store-Old123'],
    ]);
  });

  it('keeps a folder named like a word whose only file is not a page this app wrote', () => {
    const state = parent();
    folder(join(state, 'open-source'), { 'cedarloom-app.html': 'owner' }, 1000);
    sweepRedirects(state, 2_000_000, elsewhere());
    expect(readFileSync(join(state, 'open-source', 'cedarloom-app.html'), 'utf8')).toBe('owner');
  });

  // A junction needs no privilege on Windows; other platforms ignore the type.
  it('leaves a link of a redirect name and the folder it points to', () => {
    const state = parent();
    const target = join(dirname(state), 'target');
    written(target, 1000);
    folder(state, {}, 3000);
    symlinkSync(target, join(state, 'open-Lnk123'), 'junction');
    sweepRedirects(state, 2_000_000, elsewhere());
    expect([readdirSync(state), readdirSync(target)]).toEqual([['open-Lnk123'], ['cedarloom-app.html']]);
  });

  it.skipIf(process.platform === 'win32')(
    'leaves a folder whose page is a link, and the file it points to (file links need a privilege on Windows)',
    () => {
      const state = parent();
      const target = written(join(dirname(state), 'target'), 1000);
      folder(state, {}, 3000);
      mkdirSync(join(state, 'open-Pgl123'));
      symlinkSync(target, join(state, 'open-Pgl123', 'cedarloom-app.html'));
      utimesSync(join(state, 'open-Pgl123'), 1000, 1000);
      sweepRedirects(state, 2_000_000, elsewhere());
      expect([readdirSync(state), existsSync(target)]).toEqual([['open-Pgl123'], true]);
    },
  );

  it('does nothing when the state folder does not exist yet', () => {
    expect(sweepRedirects(parent(), 2_000_000, elsewhere())).toEqual([]);
  });
});

describe('sweepRedirects, a folder it cannot read', () => {
  it.skipIf(process.platform === 'win32')(
    'returns the error of a folder it cannot read and goes on with the others (POSIX modes)',
    () => {
      const state = parent();
      folder(join(state, 'open-Den123'), {}, 1000);
      chmodSync(join(state, 'open-Den123'), 0o000);
      written(join(state, 'open-Old123'), 1000);
      try {
        expect([sweepRedirects(state, 2_000_000, elsewhere()), readdirSync(state)]).toEqual([
          [expect.objectContaining({ code: 'EACCES' })],
          ['open-Den123'],
        ]);
      } finally {
        chmodSync(join(state, 'open-Den123'), 0o700);
      }
    },
  );
});
