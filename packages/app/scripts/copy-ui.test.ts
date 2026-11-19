import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';

const base = mkdtempSync(join(tmpdir(), 'cedarloom-copy-ui-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

it('replaces a linked dist/ui with a copy and keeps the link target', () => {
  // The script's paths are relative to itself, so a copy runs against a tree shaped like the workspace.
  const script = join(base, 'app', 'scripts', 'copy-ui.ts');
  const ui = join(base, 'app', 'dist', 'ui');
  mkdirSync(join(base, 'app', 'scripts'), { recursive: true });
  mkdirSync(join(base, 'app', 'dist'));
  mkdirSync(join(base, 'ui', 'dist'), { recursive: true });
  mkdirSync(join(base, 'target'));
  copyFileSync(fileURLToPath(new URL('copy-ui.ts', import.meta.url)), script);
  writeFileSync(join(base, 'ui', 'dist', 'index.html'), 'built');
  writeFileSync(join(base, 'target', 'kept.txt'), 'kept');
  // A junction needs no privilege on Windows; other platforms ignore the type.
  symlinkSync(join(base, 'target'), ui, 'junction');

  execFileSync(process.execPath, [script]);

  expect(readFileSync(join(base, 'target', 'kept.txt'), 'utf8')).toBe('kept');
  expect(lstatSync(ui).isDirectory()).toBe(true);
  expect(readFileSync(join(ui, 'index.html'), 'utf8')).toBe('built');
});
