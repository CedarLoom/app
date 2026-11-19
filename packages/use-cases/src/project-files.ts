import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const errorCode = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

/**
 * What is at a path, not following a link; undefined when nothing is, also when a folder on the way is a file or the
 * name is too long to exist.
 */
export const entryAt = (path: string) => {
  try {
    // 64-bit ids: as numbers, Windows file ids lose precision, and two files could look like one.
    return lstatSync(path, { throwIfNoEntry: false, bigint: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOTDIR' || code === 'ENAMETOOLONG') return undefined;
    throw error;
  }
};

/** Another process changed the step's file meanwhile. */
export class Changed extends Error {}

/** What is at a path: a regular file's bytes and mode, nothing, a link, or something that is not a file. */
export type Found = { bytes: Buffer; mode: number } | 'absent' | 'link' | 'not-file';

// No link followed, and no wait on a FIFO.
const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Reads a regular file from one open handle, so what is checked is what is read. */
export const readFound = (path: string): Found => {
  let fd: number;
  try {
    fd = openSync(path, READ);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return 'absent';
    // ELOOP: O_NOFOLLOW met a link; EISDIR: a platform that refuses to open a folder.
    if (code === 'ELOOP') return 'link';
    // ENOTDIR: a folder on the way is a file.
    if (code === 'EISDIR' || code === 'ENOTDIR') return 'not-file';
    throw error;
  }
  try {
    const info = fstatSync(fd);
    // Permission bits only: like a write by the kernel, a replace drops setuid and setgid.
    return info.isFile() ? { bytes: readFileSync(fd), mode: info.mode & 0o777 } : 'not-file';
  } finally {
    closeSync(fd);
  }
};

/** The hash of the regular file at a path; null for anything else. */
export const hashAt = (path: string): string | null => {
  const found = readFound(path);
  return typeof found === 'object' ? sha256(found.bytes) : null;
};

/** The temporary file of one step, next to its target, so recovery finds it from the journal. */
export const tempPath = (path: string, runId: string, position: number): string =>
  join(dirname(path), `.${basename(path)}.cedarloom-${runId}-${position}`);

/** Where a step moves the file it replaces or deletes while it checks it; recovery finds it from the journal too. */
export const asidePath = (path: string, runId: string, position: number): string =>
  `${tempPath(path, runId, position)}.old`;

const flushFolder = (path: string): void => {
  // Windows cannot open a folder to flush it; NTFS journals the rename.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/** Writes and flushes a new file; refused when the path exists, so a planted file or link is never written through. */
export const writeNew = (path: string, bytes: Uint8Array, mode: number | undefined): void => {
  const fd = openSync(path, 'wx', mode ?? 0o666);
  try {
    writeFileSync(fd, bytes);
    // The exact bits, not reduced by the umask: a 0600 file stays 0600.
    if (mode !== undefined) fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/** Makes the missing folders of a path and flushes each new one into its parent, so a crash keeps what goes in them. */
export const makeFolders = (path: string, mode = 0o777): void => {
  const first = mkdirSync(path, { recursive: true, mode });
  if (first === undefined) return;
  // Bounded by length, not by equality: Windows may spell the returned folder differently.
  for (let folder = path; folder.length >= first.length; folder = dirname(folder)) flushFolder(dirname(folder));
};

/** Writes a private copy beside `dest` and renames it in, so `dest` is whole or missing, never half written. */
export const copyAtomic = (bytes: Uint8Array, dest: string): void => {
  makeFolders(dirname(dest), 0o700);
  const temp = `${dest}.tmp`;
  try {
    writeNew(temp, bytes, 0o600);
    renameSync(temp, dest);
  } finally {
    rmSync(temp, { force: true });
  }
  flushFolder(dirname(dest));
};

// Moves a file back by a hard link, which never overwrites; false when link() fails, as on a taken path or a
// filesystem without hard links.
const linkedBack = (aside: string, path: string): boolean => {
  try {
    linkSync(aside, path);
  } catch {
    return false;
  }
  unlinkSync(aside);
  return true;
};

/** Puts a file set aside back at its path; when another process put a file there meanwhile, both stay. */
export const putBack = (aside: string, path: string, isFile: boolean): void => {
  // A link or folder goes back by rename, as a hard link to a link would follow it on macOS, and only to a free path;
  // so does a file a hard link cannot put back.
  if (!(isFile && linkedBack(aside, path))) {
    if (entryAt(path) !== undefined) return;
    renameSync(aside, path);
  }
  flushFolder(dirname(path));
};

/** Moves the target aside and checks it there; a file that no longer hashes as `before` goes back. */
export const setAside = (path: string, aside: string, before: string): void => {
  try {
    renameSync(path, aside);
  } catch (error) {
    throw errorCode(error) === 'ENOENT' ? new Changed() : error;
  }
  const found = readFound(aside);
  if (typeof found === 'object' && sha256(found.bytes) === before) return;
  putBack(aside, path, typeof found === 'object');
  throw new Changed();
};

/** Links the new file in where the path is free; a file another process put there meanwhile stays, and the step stops. */
export const linkIn = (temp: string, path: string): void => {
  try {
    linkSync(temp, path);
  } catch (error) {
    throw errorCode(error) === 'EEXIST' ? new Changed() : error;
  }
  flushFolder(dirname(path));
};

export const dropAside = (aside: string): void => {
  unlinkSync(aside);
  flushFolder(dirname(aside));
};
