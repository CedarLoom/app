import { describe, expect, it } from 'vitest';
import { stateDir } from './state-dir.ts';

const posixHome = { platform: 'linux', home: '/home/me', cwd: '/work' } as const;

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

  it('reads Windows paths on Windows', () => {
    const env = { XDG_STATE_HOME: 'D:\\xdg' };
    expect(stateDir({ env, platform: 'win32', home: 'C:\\Users\\me', cwd: 'C:\\' })).toBe('D:\\xdg\\cedarloom');
  });
});
