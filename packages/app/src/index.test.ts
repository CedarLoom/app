import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeOnSignal, run } from './index.ts';
import type { AppIo } from './start.ts';

// The io run passes to start; start itself answers nothing, so no server listens.
const given = vi.hoisted(() => ({ stateDir: (_root: string) => '', storeDir: (_root: string) => '' }));
vi.mock('./start.ts', async (original) => ({
  ...(await original<typeof import('./start.ts')>()),
  start: (io: AppIo) => {
    Object.assign(given, { stateDir: io.stateDir, storeDir: io.storeDir });
    return new Promise(() => {});
  },
}));

const folders: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('closeOnSignal', () => {
  it('exits with the code of a close that fails on the signal', async () => {
    const listeners = new Map<string, () => void>();
    const exited = new Promise<number>((exit) => {
      closeOnSignal(
        { close: () => Promise.resolve(5) },
        { once: (signal, listener) => listeners.set(signal, listener), exit },
      );
    });
    listeners.get('SIGTERM')?.();
    expect(await exited).toBe(5);
  });
});

describe('run', () => {
  it('places the page and the store of a relative CEDARLOOM_STATE_DIR under the same project root', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cedarloom-app-')));
    folders.push(root);
    vi.stubEnv('CEDARLOOM_STATE_DIR', 'state');
    run();
    expect([given.stateDir(root), dirname(given.storeDir(root))]).toEqual([join(root, 'state'), join(root, 'state')]);
  });
});
