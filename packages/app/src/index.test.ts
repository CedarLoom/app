import { afterEach, expect, it, vi } from 'vitest';
import { run } from './index.ts';

// A server that printed its start document and fails to close.
vi.mock('./start.ts', () => ({ start: async () => ({ close: () => Promise.reject(new Error('close failed')) }) }));

const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

it('prints no second document when close fails after the start document, exit 5', async () => {
  process.argv = [...argv.slice(0, 2), '--json'];
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  // Takes the signal handlers instead of registering them, so the test calls stop without a signal.
  const handlers = new Map<string | symbol, () => void>();
  vi.spyOn(process, 'once').mockImplementation((event, handler) => handlers.set(event, handler) && process);
  run();
  await vi.waitFor(() => expect(handlers.has('SIGTERM')).toBe(true));
  handlers.get('SIGTERM')?.();
  await vi.waitFor(() => expect(process.exitCode).toBe(5));
  expect([stdout.mock.calls, String(stderr.mock.calls[0]?.[0])]).toEqual([[], expect.stringContaining('close failed')]);
});
