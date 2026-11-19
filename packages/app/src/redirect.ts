import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A page only its user can read that refreshes to the session URL, so the opener's arguments name a file, not the token. */
export interface Redirect {
  path: string;
  /** Removes the page and its folder; again after that, it does nothing. */
  remove: () => void;
}

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
  const path = join(folder, 'cedarloom-app.html');
  const remove = (): void => rmSync(folder, { recursive: true, force: true });
  try {
    writeFileSync(path, page(url), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    remove();
    throw error;
  }
  return { path, remove };
};
