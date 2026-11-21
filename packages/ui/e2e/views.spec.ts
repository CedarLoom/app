import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// The built UI, served by cedarloom-app from packages/app/dist/ui (`pnpm run build`), in an empty project.
let server: ChildProcess;
let url: string;

test.beforeAll(async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cedarloom-ui-')));
  mkdirSync(join(root, '.git'));
  const bin = fileURLToPath(new URL('../../app/bin/cedarloom-app.js', import.meta.url));
  server = spawn(process.execPath, [bin, '--no-open', '--json', '--port', '0'], {
    cwd: root,
    env: { ...process.env, CEDARLOOM_STATE_DIR: join(root, '.state') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [line] = await once(createInterface({ input: server.stdout ?? process.stdin }), 'line');
  url = JSON.parse(String(line)).result.url;
});

test.afterAll(() => server.kill());

const accessible = async (page: Page): Promise<void> => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations).toEqual([]);
};

test('the token in the fragment opens the session, leaves the address and each view renders', async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole('tab', { name: 'Doctor' })).toBeVisible();
  expect(page.url()).toBe(new URL('/', url).href);
  await expect(page.getByRole('cell', { name: 'Node.js' })).toBeVisible();
  await accessible(page);
  await page.getByRole('tab', { name: 'Runs' }).click();
  await expect(page.getByText('No runs yet.')).toBeVisible();
  await accessible(page);
  await page.getByRole('tab', { name: 'Workflows' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Workflows' }).locator('.mantine-Loader-root')).toHaveCount(0);
  await accessible(page);
});

test('without the token the session is refused and no view renders', async ({ page }) => {
  await page.goto(new URL('/', url).href);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await accessible(page);
});
