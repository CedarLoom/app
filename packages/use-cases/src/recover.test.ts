import { mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recover } from './recover.ts';
import { begin, hash, project, recovered, request, run, store } from './test-fixtures.ts';

const replaceStep = {
  kind: 'replace',
  path: '.claude/l.md',
  beforeHash: hash('old\n'),
  afterHash: hash('a\n'),
} as const;
const deleteStep = { kind: 'delete', path: '.claude/l.md', beforeHash: hash('old\n'), afterHash: null } as const;

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
  it.skipIf(process.platform === 'win32').each([
    ['a replace with its temporary file left whose put-back was killed before the aside went', replaceStep, true, true],
    ['a replace without its temporary file whose put-back was killed before the aside went', replaceStep, false, true],
    ['a delete whose put-back was killed before the aside went', deleteStep, false, true],
    ['a replace with its temporary file left whose put-back was killed after the aside went', replaceStep, true, false],
  ] as const)('keeps one link and settles %s as untouched', (_, step, temp, aside) => {
    const { root, state } = project();
    const held = store(state);
    held.begin({ ...request(root, []).run, planHash: 'a'.repeat(64), operations: [{ ...step, entries: null }] });
    if (temp) writeFileSync(join(root, '.claude/.l.md.cedarloom-r1-0'), 'a\n');
    symlinkSync('target.md', join(root, '.claude/l.md'));
    if (aside) symlinkSync('target.md', join(root, '.claude/.l.md.cedarloom-r1-0.old'));
    expect(recover(held, root)).toEqual([recovered('.claude/l.md')]);
    expect(recover(held, root)).toEqual([]);
    expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['untouched'] });
    expect(readdirSync(join(root, '.claude'))).toEqual(['l.md']);
    expect(readlinkSync(join(root, '.claude/l.md'))).toBe('target.md');
  });
});
