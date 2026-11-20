import { chmodSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makesHardLinks } from './project-files.ts';
import { fresh } from './test-fixtures.ts';

describe('the volume probe', () => {
  it('removes an old probe folder that holds only empty files, and keeps a new one, one holding text and a file', () => {
    const folder = fresh();
    const old = new Date('2000-01-01T00:00:00.000Z');
    const probe = (name: string, files: Record<string, string>, time?: Date): void => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(folder, name, path, '..'), { recursive: true });
        writeFileSync(join(folder, name, path), text);
      }
      if (time !== undefined) utimesSync(join(folder, name), time, time);
    };
    probe('.cedarloom-probe-old', { 'a/b.md': '', c: '' }, old);
    probe('.cedarloom-probe-new', { a: '' });
    probe('.cedarloom-probe-text', { a: '', 'b.md': 'mine\n' }, old);
    writeFileSync(join(folder, '.cedarloom-probe-file'), '');
    utimesSync(join(folder, '.cedarloom-probe-file'), old, old);
    expect(makesHardLinks(folder)).toBe(true);
    expect(readdirSync(folder).toSorted()).toEqual([
      '.cedarloom-probe-file',
      '.cedarloom-probe-new',
      '.cedarloom-probe-text',
    ]);
    expect(readdirSync(join(folder, '.cedarloom-probe-text')).toSorted()).toEqual(['a', 'b.md']);
  });

  // A folder mode keeps neither root nor any process on Windows out.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps an old probe folder it may not read',
    () => {
      const folder = fresh();
      const probe = join(folder, '.cedarloom-probe-theirs');
      mkdirSync(probe);
      utimesSync(probe, new Date('2000-01-01T00:00:00.000Z'), new Date('2000-01-01T00:00:00.000Z'));
      chmodSync(probe, 0o000);
      try {
        expect(makesHardLinks(folder)).toBe(true);
      } finally {
        chmodSync(probe, 0o700);
      }
      expect(readdirSync(folder)).toEqual(['.cedarloom-probe-theirs']);
    },
  );
});
