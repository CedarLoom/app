import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A page only its user can read that refreshes to the session URL, so the opener's arguments name a file, not the token. */
export interface Redirect {
  path: string;
  /** Removes the page and its folder; again after that, it does nothing. */
  remove: () => void;
}

// The URL holds only a port and a base64url token, none of which the attribute needs escaped.
const PAGE = 'cedarloom-app.html';
// mkdtemp's six random letters and digits after the prefix.
const FOLDER = /^open-[A-Za-z0-9]{6}$/;

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

// A real folder, no link, holding nothing but the page as a real file, if anything.
const redirectFolder = (folder: string, before: number): boolean => {
  const stat = lstatSync(folder);
  if (!stat.isDirectory() || stat.mtimeMs >= before) return false;
  return readdirSync(folder).every((name) => name === PAGE && lstatSync(join(folder, name)).isFile());
};

/** Removes the redirect folders in `parent` last changed before `before` (ms since the epoch); others stay. */
export const sweepRedirects = (parent: string, before: number): void => {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  for (const name of names.filter((entry) => FOLDER.test(entry))) {
    const folder = join(parent, name);
    try {
      if (redirectFolder(folder, before)) rmSync(folder, { recursive: true, force: true });
    } catch (error) {
      // Another start swept it first.
      if (!missing(error)) throw error;
    }
  }
};
