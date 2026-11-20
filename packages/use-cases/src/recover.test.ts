import { mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recover } from './recover.ts';
import { begin, hash, project, recovered, run, store } from './test-fixtures.ts';

describe('recovery', () => {
  it('settles an interrupted create whose file a folder replaced as changed', () => {
    const { root, state } = project();
    const held = store(state);
    begin(held, root, '.claude/a.md');
    writeFileSync(join(root, '.claude/.a.md.cedarloom-r1-0'), 'a\n');
    mkdirSync(join(root, '.claude/a.md'));
    expect(recover(held, root)).toEqual([recovered('.claude/a.md')]);
    expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['settled'] });
  });

  // Recovery puts a link back by a new link only off Windows.
  it.skipIf(process.platform === 'win32')(
    'keeps one link and settles the step as untouched where a put-back was killed before the aside went',
    () => {
      const { root, state } = project();
      const held = store(state);
      begin(held, root, '.claude/l.md', hash('old\n'));
      writeFileSync(join(root, '.claude/.l.md.cedarloom-r1-0'), 'a\n');
      symlinkSync('target.md', join(root, '.claude/l.md'));
      symlinkSync('target.md', join(root, '.claude/.l.md.cedarloom-r1-0.old'));
      expect(recover(held, root)).toEqual([recovered('.claude/l.md')]);
      expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['untouched'] });
      expect(readdirSync(join(root, '.claude'))).toEqual(['l.md']);
      expect(readlinkSync(join(root, '.claude/l.md'))).toBe('target.md');
    },
  );
});
