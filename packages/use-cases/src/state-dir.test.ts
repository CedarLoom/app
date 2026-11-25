import { describe, expect, it } from 'vitest';
import { resolvedStoreDir, stateDir, storeDir } from './state-dir.ts';

const posixHome = { platform: 'linux', home: '/home/me', cwd: '/work' } as const;
const realpath = (path: string): string => path.replace('/work/link', '/work/repo');

describe('stateDir', () => {
  it.each([
    ['CEDARLOOM_STATE_DIR first', { CEDARLOOM_STATE_DIR: '/state', XDG_STATE_HOME: '/xdg' }, '/state'],
    ['a relative CEDARLOOM_STATE_DIR from the working folder', { CEDARLOOM_STATE_DIR: 'state' }, '/work/state'],
    [
      'XDG_STATE_HOME when CEDARLOOM_STATE_DIR is empty',
      { CEDARLOOM_STATE_DIR: '', XDG_STATE_HOME: '/xdg' },
      '/xdg/cedarloom',
    ],
    ['the default for a relative XDG_STATE_HOME', { XDG_STATE_HOME: 'xdg' }, '/home/me/.local/state/cedarloom'],
    ['the default for an empty XDG_STATE_HOME', { XDG_STATE_HOME: '' }, '/home/me/.local/state/cedarloom'],
  ])('takes %s', (_name, env, expected) => {
    expect(stateDir({ env, ...posixHome })).toBe(expected);
  });

  it.each([
    ['linux', '/home/me', '/home/me/.local/state/cedarloom'],
    ['darwin', '/Users/me', '/Users/me/.local/state/cedarloom'],
    ['win32', 'C:\\Users\\me', 'C:\\Users\\me\\AppData\\Local\\cedarloom'],
  ] as const)('defaults on %s', (platform, home, expected) => {
    expect(stateDir({ env: {}, platform, home, cwd: home })).toBe(expected);
  });

  it('defaults to LOCALAPPDATA on Windows', () => {
    const env = { LOCALAPPDATA: 'D:\\Local' };
    expect(stateDir({ env, platform: 'win32', home: 'C:\\Users\\me', cwd: 'C:\\' })).toBe('D:\\Local\\cedarloom');
  });

  it('gives each project its own store folder, named by the hash of its real path', () => {
    expect(storeDir({ env: {}, ...posixHome, projectRoot: 'link', realpath })).toBe(
      '/home/me/.local/state/cedarloom/ddc5e473a09bd156',
    );
  });

  it('takes a relative CEDARLOOM_STATE_DIR from the project root for the store folder, not from the working folder', () => {
    const env = { CEDARLOOM_STATE_DIR: 'state' };
    expect(storeDir({ env, ...posixHome, cwd: '/work/link/docs', projectRoot: '/work/link', realpath })).toBe(
      '/work/repo/state/ddc5e473a09bd156',
    );
  });

  it('reads Windows paths on Windows', () => {
    const env = { XDG_STATE_HOME: 'D:\\xdg' };
    expect(stateDir({ env, platform: 'win32', home: 'C:\\Users\\me', cwd: 'C:\\' })).toBe('D:\\xdg\\cedarloom');
  });

  it("takes a CEDARLOOM_STATE_DIR relative to another drive from that drive's root folder, not the process's folder", () => {
    const env = { CEDARLOOM_STATE_DIR: 'C:state' };
    expect(stateDir({ env, platform: 'win32', home: 'C:\\Users\\me', cwd: 'D:\\project' })).toBe('C:\\state');
  });
});

// A system error (ENOENT, syscall realpath) and an argument error (ERR_INVALID_ARG_VALUE, no syscall).
const missing = (): string => {
  throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT', syscall: 'realpath' });
};
const invalid = (): string => {
  throw Object.assign(new TypeError('path must not hold null bytes'), { code: 'ERR_INVALID_ARG_VALUE' });
};

describe('resolvedStoreDir', () => {
  it('refuses a store folder stopped by a system error with project.path-unresolvable', () => {
    expect(resolvedStoreDir('/work/repo', missing)).toEqual({
      code: 'project.path-unresolvable',
      params: { path: '/work/repo' },
    });
  });

  it('lets an error without a syscall propagate', () => {
    expect(() => resolvedStoreDir('/work/repo', invalid)).toThrow('path must not hold null bytes');
  });
});
