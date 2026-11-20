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
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants as os } from 'node:os';
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
// Opening a socket: ENXIO on Linux, EOPNOTSUPP on macOS, which Node.js names by its number alone.
const SOCKET = new Set<unknown>([-os.errno.ENXIO, -os.errno.EOPNOTSUPP]);
const errorNumber = (error: unknown): unknown => (error instanceof Error && 'errno' in error ? error.errno : undefined);

// The first length bytes of the file open at fd.
const headOf = (fd: number, length: number): Buffer => {
  const bytes = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const count = readSync(fd, bytes, filled, length - filled, filled);
    if (count === 0) break;
    filled += count;
  }
  return bytes.subarray(0, filled);
};

/** Reads a regular file, or its first limit bytes, from one open handle, so what is checked is what is read. */
export const readFound = (path: string, limit = Number.POSITIVE_INFINITY): Found => {
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
    if (SOCKET.has(errorNumber(error))) return 'not-file';
    throw error;
  }
  try {
    const info = fstatSync(fd);
    // Permission bits only: like a write by the kernel, a replace drops setuid and setgid.
    if (!info.isFile()) return 'not-file';
    return { bytes: info.size > limit ? headOf(fd, limit) : readFileSync(fd), mode: info.mode & 0o777 };
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

/**
 * Makes the missing folders of a path, at most `levels` of them, each flushed into its parent so a crash keeps them;
 * gives how many it made. Throws ENOENT where the folder above them is gone.
 */
export const makeFolders = (path: string, mode = 0o777, levels = Number.POSITIVE_INFINITY): number => {
  const missing: string[] = [];
  for (let at = path; missing.length < levels && entryAt(at) === undefined && dirname(at) !== at; at = dirname(at))
    missing.push(at);
  // One at a time from the top, never recursive, so a project root that is gone is not made again.
  for (const folder of missing.toReversed()) mkdirSync(folder, { mode });
  for (const folder of missing) flushFolder(dirname(folder));
  return missing.length;
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

// Puts an aside back by a new name, which never replaces what is at the path: a hard link for a file, a link with the
// same target for a link; false when that fails, as on a taken path or a filesystem without hard links.
const linkedBack = (aside: string, path: string): boolean => {
  const entry = entryAt(aside);
  try {
    if (entry?.isFile()) linkSync(aside, path);
    // A hard link to a link would follow it on macOS; Windows needs the link's kind to make it again.
    else if (entry?.isSymbolicLink() && process.platform !== 'win32') symlinkSync(readlinkSync(aside, 'buffer'), path);
    else return false;
  } catch {
    return false;
  }
  // A stop between the link and the unlink leaves the aside as the file at the path, which recovery drops.
  unlinkSync(aside);
  return true;
};

/** Puts a file, link or folder set aside back at its path; when another process put a file there meanwhile, both stay. */
export const putBack = (aside: string, path: string): void => {
  // Node.js has no rename that refuses a taken path: where no new name puts the aside back, as for a folder, a link on
  // Windows or a file on a volume without hard links, a file put at the path between this check and the rename is
  // replaced.
  if (!linkedBack(aside, path)) {
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
  putBack(aside, path);
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

/** Removes a file and flushes its folder, so a crash after it never finds the file again. */
export const dropAside = (aside: string): void => {
  unlinkSync(aside);
  flushFolder(dirname(aside));
};

// rmdir of a folder that holds something, or that is gone meanwhile, and of one the filesystem keeps for now.
const KEPT_FOLDER = new Set<unknown>(['ENOTEMPTY', 'EEXIST', 'ENOENT', 'EACCES', 'EPERM', 'EROFS', 'EBUSY']);

/** Removes a folder that holds nothing; false when it holds something or the filesystem keeps it. */
export const removeEmptyFolder = (path: string): boolean => {
  try {
    rmdirSync(path);
  } catch (error) {
    if (KEPT_FOLDER.has(errorCode(error))) return false;
    throw error;
  }
  return true;
};

// link() of a volume without hard links: ENOTSUP on exFAT and FAT, EISDIR there on Windows, EPERM or EXDEV on some
// network shares.
const NO_HARD_LINKS = new Set<unknown>(['ENOTSUP', 'EISDIR', 'EPERM', 'EXDEV']);

const PROBE = '.cedarloom-probe-';
// A probe lives for milliseconds; one an hour old was left by a process that stopped.
const PROBE_AGE_MS = 60 * 60 * 1000;

// Whether a folder holds nothing but empty files and folders that do, as a probe does.
const onlyEmpty = (folder: string): boolean =>
  readdirSync(folder).every((name) => {
    const entry = lstatSync(join(folder, name));
    return entry.isDirectory() ? onlyEmpty(join(folder, name)) : entry.isFile() && entry.size === 0;
  });

// Removes the empty files of a folder and then each folder once it is empty; a file written meanwhile stays.
const removeEmpty = (folder: string): void => {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    const entry = lstatSync(path);
    if (entry.isDirectory()) removeEmpty(path);
    else if (entry.isFile() && entry.size === 0) unlinkSync(path);
  }
  removeEmptyFolder(folder);
};

// Removes the probes in a folder that a stopped process left: folders changed before `before` that hold only empty files.
const sweepProbes = (folder: string, before: number): void => {
  for (const name of readdirSync(folder)) {
    if (!name.startsWith(PROBE)) continue;
    const path = join(folder, name);
    const entry = lstatSync(path);
    if (entry.isDirectory() && entry.mtimeMs < before && onlyEmpty(path)) removeEmpty(path);
  }
};

// What a probe in a private folder made in `folder` finds; the folder goes after.
const probed = <T>(folder: string, find: (probe: string) => T): T => {
  const probe = mkdtempSync(join(folder, PROBE));
  try {
    // Aged by the volume's clock, as the new probe's time reads it.
    sweepProbes(folder, lstatSync(probe).mtimeMs - PROBE_AGE_MS);
    return find(probe);
  } finally {
    // A scanner that holds the new file on Windows makes a single try fail with EBUSY or EPERM.
    rmSync(probe, { recursive: true, force: true, maxRetries: 3 });
  }
};

/** Whether a folder reads two relative paths as one file, probed in a private folder there, which goes after. */
export const readsAsOne = (folder: string, path: string, other: string): boolean =>
  probed(folder, (probe) => {
    const made = join(probe, path);
    mkdirSync(dirname(made), { recursive: true });
    writeFileSync(made, '');
    const [one, two] = [entryAt(made), entryAt(join(probe, other))];
    return one !== undefined && two !== undefined && one.dev === two.dev && one.ino === two.ino;
  });

/** Whether the volume of a folder makes hard links, probed by a link in a private folder there, which goes after. */
export const makesHardLinks = (folder: string): boolean =>
  probed(folder, (probe) => {
    writeFileSync(join(probe, 'a'), '');
    try {
      linkSync(join(probe, 'a'), join(probe, 'b'));
    } catch (error) {
      if (NO_HARD_LINKS.has(errorCode(error))) return false;
      throw error;
    }
    return true;
  });
