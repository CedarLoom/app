import { writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readFound } from './project-files.ts';
import { fresh } from './test-fixtures.ts';

// fstat reports size 0 while `reportsEmpty.on`, as procfs does for files that hold bytes.
const reportsEmpty = vi.hoisted(() => ({ on: false }));
// open throws `openFails.error` while it is set.
const openFails = vi.hoisted((): { error: Error | undefined } => ({ error: undefined }));
vi.mock('node:fs', async (load) => {
  const fs = await load<typeof import('node:fs')>();
  const fstatSync = (fd: number) => Object.assign(fs.fstatSync(fd), reportsEmpty.on ? { size: 0 } : {});
  const openSync: typeof fs.openSync = (path, flags, mode) => {
    if (openFails.error !== undefined) throw openFails.error;
    return fs.openSync(path, flags, mode);
  };
  return { ...fs, fstatSync, openSync };
});
afterEach(() => {
  reportsEmpty.on = false;
  openFails.error = undefined;
});

it('reads no more than the limit of a file whose size reads as 0', () => {
  const path = join(fresh(), 'a.md');
  writeFileSync(path, 'abcdefghij');
  reportsEmpty.on = true;
  expect(readFound(path, 4)).toMatchObject({ bytes: Buffer.from('abcd') });
});

it('throws the error number that opening a socket gives only on another platform, as it means another failure here', () => {
  const name = process.platform === 'linux' ? 'EOPNOTSUPP' : 'ENXIO';
  const error = Object.assign(new Error(`${name}: open failed`), { errno: -constants.errno[name] });
  openFails.error = error;
  expect(() => readFound(join(fresh(), 'a.md'), 4)).toThrow(error);
});
