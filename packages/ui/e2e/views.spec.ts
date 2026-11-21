import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// The built UI, served by cedarloom-app from packages/app/dist/ui (`pnpm run build`), in an empty project.
let root: string | undefined;
let server: ChildProcessByStdio<null, Readable, null> | undefined;
let url: string;

test.beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cedarloom-ui-')));
  mkdirSync(join(root, '.git'));
  const bin = fileURLToPath(new URL('../../app/bin/cedarloom-app.js', import.meta.url));
  server = spawn(process.execPath, [bin, '--no-open', '--json', '--port', '0'], {
    cwd: root,
    // HOME and the plugin locator's own variables too, so no plugin installed on the machine shows in the views.
    env: {
      ...process.env,
      CEDARLOOM_STATE_DIR: join(root, '.state'),
      HOME: root,
      USERPROFILE: root,
      CLAUDE_CONFIG_DIR: undefined,
      CLAUDE_CODE_PLUGIN_CACHE_DIR: undefined,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // A server that exits before its first line fails the run instead of leaving it waiting.
  const [line] = await Promise.race([
    once(createInterface({ input: server.stdout }), 'line'),
    once(server, 'exit').then(([code]) => Promise.reject(new Error(`cedarloom-app exited with ${code}`))),
  ]);
  url = JSON.parse(String(line)).result.url;
});

// beforeAll may have failed before the spawn, or the server may have exited already.
test.afterAll(async () => {
  try {
    if (server?.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'exit');
    }
  } finally {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

const accessible = async (page: Page): Promise<void> => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations).toEqual([]);
};

// The tab's panel once its request is answered without an error.
const opened = async (page: Page, tab: string): Promise<void> => {
  await page.getByRole('tab', { name: tab }).click();
  await expect(page.getByRole('tabpanel', { name: tab })).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
};

test('the token in the fragment opens the session, leaves the address and each view renders', async ({ page }) => {
  // The printed link pasted into a tab that already shows the page without a session.
  await page.goto(new URL('/', url).href);
  await expect(page.getByRole('alert')).toBeVisible();
  await page.goto(url);
  await expect(page.getByRole('tabpanel', { name: 'Doctor' }).getByRole('table')).toBeVisible();
  expect(page.url()).toBe(new URL('/', url).href);
  await accessible(page);
  await opened(page, 'Runs');
  await accessible(page);
  await opened(page, 'Workflows');
  await accessible(page);
  // The printed link opened again: its token is spent, the cookie of the first opening holds.
  const again = await page.context().newPage();
  await again.goto(url);
  await expect(again.getByRole('tabpanel', { name: 'Doctor' }).getByRole('table')).toBeVisible();
});

test('without the token the session is refused and no view renders', async ({ page }) => {
  await page.goto(new URL('/', url).href);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await accessible(page);
});
