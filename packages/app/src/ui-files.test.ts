import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, expect, it } from 'vitest';
import { uiRoutes } from './ui-files.ts';

const root = mkdtempSync(join(tmpdir(), 'cedarloom-ui-files-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'assets'));
writeFileSync(join(root, 'index.html'), '<!doctype html>');
// A link to itself; a junction needs no privilege on Windows and other platforms ignore the type.
symlinkSync(join(root, 'assets', 'loop'), join(root, 'assets', 'loop'), 'junction');

it('answers a link loop under the UI folder with 404', async () => {
  const app = Fastify();
  uiRoutes(app, root);
  const reply = await app.inject({ method: 'GET', url: '/assets/loop/app.js' });
  expect(reply.statusCode).toBe(404);
});
