import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** A page only its user can read that refreshes to the session URL, so the opener's arguments name a file, not the token. */
export interface Redirect {
  path: string;
  /** Removes the page and its folder; again after that, it does nothing. */
  remove: () => void;
}

const PAGE = 'cedarloom-app.html';
// mkdtemp's six random letters and digits after the prefix.
const FOLDER = /^open-[A-Za-z0-9]{6}$/;
const URL_IN_PAGE = /url=(http:\/\/127\.0\.0\.1:\d{1,5}\/#t=[\w-]+)"/;
// Far above the size of a written page, so a sweep never reads a large file.
const PAGE_LIMIT = 4096;

// The URL holds only a port and a base64url token, none of which the attribute needs escaped.
const page = (url: string): string =>
  `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${url}">
<title>CedarLoom</title>
</head>
<body>
<p><a href="${url}">CedarLoom</a></p>
</body>
</html>
`;

/** Writes the page into a new folder in `parent`: mkdtemp creates it with mode 0700, the page gets 0600. */
export const writeRedirect = (parent: string, url: string): Redirect => {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const folder = mkdtempSync(join(parent, 'open-'));
  const path = join(folder, PAGE);
  const remove = (): void => rmSync(folder, { recursive: true, force: true });
  try {
    writeFileSync(path, page(url), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    remove();
    throw error;
  }
  return { path, remove };
};

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

// The text of a real file no larger than a page, or undefined.
const pageText = (path: string): string | undefined => {
  const stat = lstatSync(path);
  return stat.isFile() && stat.size <= PAGE_LIMIT ? readFileSync(path, 'utf8') : undefined;
};

// A real folder, no link, holding nothing but a page this app wrote: an empty one or a word like open-source stays.
const redirectFolder = (folder: string, before: number): boolean => {
  const stat = lstatSync(folder);
  if (!stat.isDirectory() || stat.mtimeMs >= before) return false;
  const names = readdirSync(folder);
  if (names.length !== 1 || names[0] !== PAGE) return false;
  const text = pageText(join(folder, PAGE));
  const url = text === undefined ? undefined : URL_IN_PAGE.exec(text)?.[1];
  return url !== undefined && text === page(url);
};

/**
 * Removes the redirect folders in `parent` last changed before `before` (ms since the epoch), except the folder of
 * `own`; others stay. Returns the error of each folder it could not check or remove.
 */
export const sweepRedirects = (parent: string, before: number, own: Redirect): unknown[] => {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const errors: unknown[] = [];
  for (const name of names.filter((entry) => FOLDER.test(entry))) {
    const folder = join(parent, name);
    if (folder === dirname(own.path)) continue;
    try {
      if (!redirectFolder(folder, before)) continue;
      // rmdir, not a recursive removal, keeps a folder that got another entry since the check; the page unlink before it
      // still follows a folder swapped for a link.
      rmSync(join(folder, PAGE), { force: true });
      rmdirSync(folder);
    } catch (error) {
      // Another start swept it first.
      if (!missing(error)) errors.push(error);
    }
  }
  return errors;
};
