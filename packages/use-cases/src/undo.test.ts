import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { apply, type Boundary } from './apply.ts';
import {
  begin,
  crash,
  create,
  failAt,
  fresh,
  listing,
  project,
  recovered,
  refusedAt,
  release,
  remove,
  replace,
  request,
  run,
  runs,
  store,
  storeWith,
  text,
  thrownBy,
  undone,
} from './test-fixtures.ts';
import { undo } from './undo.ts';

describe('undo stops a run', () => {
  it('names an undo it stops with what the recovery before its plan settled', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state, 'r1', 'r0', 'u1');
    apply(held, request(root, [replace('.claude/b.md', 'old\n', 'new\n')]));
    begin(held, root, '.claude/a.md');
    writeFileSync(join(root, '.claude/.a.md.cedarloom-r0-0'), 'a\n');
    expect(thrownBy(() => undo(held, { root, run: 'r1' }, failAt('linked', 0)))).toMatchObject({
      run: 'u1',
      findings: [recovered('.claude/a.md', 'r0'), recovered('.claude/b.md', 'u1')],
    });
  });
});

describe('recovery of a step that changed its path, then edited', () => {
  it('settles a create killed after linked, so undo refuses the edited file', async () => {
    const { root, state } = project();
    await crash(state, request(root, [create('.claude/a.md', 'a\n')]), 'linked', 0);
    writeFileSync(join(root, '.claude/a.md'), 'mine\n');
    expect(undo(store(state, 'u1'), { root, run: 'r1' })).toMatchObject({
      refusal: { code: 'undo.file-changed', params: { path: '.claude/a.md' } },
      findings: [recovered('.claude/a.md')],
    });
    expect([run(state, 'r1'), text(join(root, '.claude/a.md'))]).toEqual([
      { status: 'interrupted', steps: ['settled'] },
      'mine\n',
    ]);
  }, 20_000);
});

describe('undo', () => {
  it('restores each file to its text from before the run, newest step first, as a run of its own', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n', '.claude/c.md': 'gone\n' });
    const held = store(state, 'r1', 'u1');
    const plan = [
      create('.claude/a.md', 'a\n'),
      replace('.claude/b.md', 'old\n', 'v2\n'),
      replace('.claude/b.md', 'v2\n', 'new\n'),
      remove('.claude/c.md', 'gone\n'),
    ];
    expect(apply(held, request(root, plan)).refusal).toBeNull();
    const result = undo(held, { root, run: 'r1' });
    expect([result.run, result.refusal, result.findings]).toEqual(['u1', null, []]);
    expect(result.plan?.operations.map(({ kind, path }) => `${kind} ${path}`)).toEqual([
      'create .claude/c.md',
      'replace .claude/b.md',
      'replace .claude/b.md',
      'delete .claude/a.md',
    ]);
    expect(listing(root)).toEqual(['b.md', 'c.md']);
    expect([text(join(root, '.claude/b.md')), text(join(root, '.claude/c.md'))]).toEqual(['old\n', 'gone\n']);
    expect(run(state, 'u1')).toEqual({ status: 'done', steps: ['done', 'done', 'done', 'done'] });
    expect(undone(state, 'r1')).toBe('u1');
  });

  it('undo refuses a file changed after the run, and restores nothing', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state, 'r1', 'u1');
    apply(held, request(root, [replace('.claude/b.md', 'old\n', 'new\n'), create('.claude/a.md', 'a\n')]));
    writeFileSync(join(root, '.claude/b.md'), 'theirs\n');
    expect(undo(held, { root, run: 'r1' })).toEqual({
      ...refusedAt('undo.file-changed', '.claude/b.md'),
      plan: null,
    });
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['a.md', 'b.md'], 'theirs\n']);
    expect(runs(state)).toEqual(['done']);
  });

  it.each([
    ['undo.backup-missing', (backup: string) => rmSync(backup)],
    ['undo.backup-changed', (backup: string) => writeFileSync(backup, 'other\n')],
  ] as const)('undo refuses with %s when the backup is missing or changed', (code, spoil) => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state, 'r1', 'u1');
    apply(held, request(root, [replace('.claude/b.md', 'old\n', 'new\n')]));
    spoil(join(state, 'backups/r1/0'));
    expect(undo(held, { root, run: 'r1' }).refusal).toEqual({ code, params: { path: '.claude/b.md' } });
    expect(text(join(root, '.claude/b.md'))).toBe('new\n');
  });
});

describe('undo refuses', () => {
  it('undo refuses a file a failed step of the run left changed', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state, 'r1', 'u1');
    const race = (boundary: Boundary, position: number): void => {
      if (boundary === 'set-aside' && position === 1) writeFileSync(join(root, '.claude/b.md'), 'theirs\n');
    };
    apply(held, request(root, [create('.claude/a.md', 'a\n'), replace('.claude/b.md', 'old\n', 'new\n')]), race);
    expect(run(state, 'r1')).toEqual({ status: 'failed', steps: ['done', 'failed'] });
    expect(undo(held, { root, run: 'r1' }).refusal).toEqual({
      code: 'undo.file-changed',
      params: { path: '.claude/b.md' },
    });
    expect(listing(root)).toEqual(['a.md', 'b.md']);
  }, 20_000);

  it('refuses a run id the store does not have as no run', () => {
    const { root, state } = project();
    const held = store(state);
    apply(held, request(root, [create('.claude/a.md', 'a\n')]));
    expect(undo(held, { root, run: 'r9' }).refusal).toEqual({ code: 'run.not-found', params: { run: 'r9' } });
  });

  it('refuses a link on the way of a file the run wrote, also when nothing is left to restore', () => {
    const { root, state } = project();
    const held = store(state, 'r1', 'u1');
    apply(held, request(root, [create('.claude/skills/a.md', 'a\n')]));
    renameSync(join(root, '.claude/skills'), join(root, '.claude/moved'));
    symlinkSync(fresh(), join(root, '.claude/skills'), 'junction');
    expect(undo(held, { root, run: 'r1' }).refusal).toEqual({
      code: 'plan.symlink',
      params: { path: '.claude/skills' },
    });
  });
});

describe('undo below a folder the app may not enter', () => {
  // A folder mode keeps neither root nor any process on Windows out.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses a file of the chain below a folder the app may not enter with plan.folder-denied',
    () => {
      const { root, state } = project({ '.claude/b.md': 'old\n' });
      const held = store(state, 'r1', 'u1', 'u2', 'u3');
      apply(held, request(root, [create('.claude/s/a.md', 'a\n'), replace('.claude/b.md', 'old\n', 'new\n')]));
      rmSync(join(root, '.claude/s/a.md'));
      writeFileSync(join(root, '.claude/s/mine.md'), 'mine\n');
      expect(undo(held, { root, run: 'r1' }).refusal).toBeNull();
      expect(undo(held, { root, run: 'u1' }).refusal).toBeNull();
      const folder = join(root, '.claude/s');
      chmodSync(folder, 0o600);
      try {
        expect(undo(held, { root, run: 'u2' }).refusal).toEqual({
          code: 'plan.folder-denied',
          params: { path: '.claude/s/a.md' },
        });
      } finally {
        chmodSync(folder, 0o700);
      }
    },
  );
});

describe('undo of an undo', () => {
  it('restores the run result, and refuses a run that is not in effect', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state, 'r1', 'u1', 'u2', 'u3');
    apply(held, request(root, [create('.claude/a.md', 'a\n'), replace('.claude/b.md', 'old\n', 'new\n')]));
    expect(undo(held, { root, run: 'r1' }).run).toBe('u1');
    expect(undo(held, { root, run: 'r1' }).refusal).toEqual({
      code: 'run.already-undone',
      params: { run: 'r1', by: 'u1' },
    });
    expect(undo(held, { root, run: 'u1' }).run).toBe('u2');
    expect([text(join(root, '.claude/a.md')), text(join(root, '.claude/b.md'))]).toEqual(['a\n', 'new\n']);
    expect(undo(held, { root, run: 'u1' }).refusal).toEqual({
      code: 'run.already-undone',
      params: { run: 'u1', by: 'u2' },
    });
    expect(undo(held, { root, run: 'r1' }).run).toBe('u3');
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'old\n']);
  });

  it('an undo that fails midway can be undone, and a file it never reached is left alone', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state, 'r1', 'u1', 'u2');
    apply(held, request(root, [create('.claude/a.md', 'a\n'), replace('.claude/b.md', 'old\n', 'new\n')]));
    const edit = (boundary: Boundary, position: number): void => {
      if (boundary === 'written' && position === 0) writeFileSync(join(root, '.claude/a.md'), 'theirs\n');
    };
    expect(undo(held, { root, run: 'r1' }, edit).refusal).toEqual({
      code: 'plan.file-changed',
      params: { path: '.claude/a.md' },
    });
    expect([run(state, 'u1'), undone(state, 'r1')]).toEqual([{ status: 'failed', steps: ['done', 'untouched'] }, null]);
    expect(undo(held, { root, run: 'u1' }).run).toBe('u2');
    expect([text(join(root, '.claude/a.md')), text(join(root, '.claude/b.md'))]).toEqual(['theirs\n', 'new\n']);
  });

  it('waits for a step recovery left unsettled while a link is on its way', () => {
    const { root, state } = project();
    const held = store(state);
    begin(held, root, '.claude/skills/a.md');
    symlinkSync(fresh(), join(root, '.claude/skills'), 'junction');
    expect(undo(held, { root, run: 'r1' }).refusal).toEqual({
      code: 'apply.unsettled',
      params: { run: 'r1', path: '.claude/skills/a.md' },
    });
  });
});

// r1 replaces old with new, then each id is undone in turn; `!` marks an undo stopped after its write.
const undos = (ids: readonly string[]) => {
  const { root, state } = project({ '.claude/b.md': 'old\n' });
  const held = store(state, 'r1', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6');
  apply(held, request(root, [replace('.claude/b.md', 'old\n', 'new\n')]));
  for (const id of ids) {
    if (!id.endsWith('!')) expect(undo(held, { root, run: id }).refusal).toBeNull();
    else expect(() => undo(held, { root, run: id.slice(0, -1) }, failAt('linked', 0))).toThrow('disk gone');
  }
  return { root, held, file: () => text(join(root, '.claude/b.md')) };
};

describe('undo of a replaced undo', () => {
  // Each undo before the last one runs; the last one would leave r1 counted as in effect, or not, against its file.
  it.each([
    [['r1', 'u1', 'r1'], 'old\n', 'run.already-undone'],
    [['r1', 'u1', 'r1', 'u3'], 'new\n', 'undo.replaced'],
  ] as const)('refuses to undo u2 after the undos of %j: u3 replaced u1 as the undo of r1', (before, left, code) => {
    const { root, held, file } = undos(before);
    expect(undo(held, { root, run: 'u2' }).refusal).toEqual({ code, params: { run: 'r1', by: 'u3' } });
    expect(file()).toBe(left);
  });

  it('refuses to undo an interrupted undo once a newer undo of the run is recorded', () => {
    const { root, held, file } = undos(['r1!', 'r1']);
    expect(undo(held, { root, run: 'u1' }).refusal).toEqual({
      code: 'run.already-undone',
      params: { run: 'r1', by: 'u2' },
    });
    expect(file()).toBe('old\n');
  });

  it('refuses to bring back an undo that restored nothing once the file holds the run result again', () => {
    const { root, held, file } = undos(['r1!', 'r1', 'u2', 'u1']);
    expect(file()).toBe('new\n');
    expect(undo(held, { root, run: 'u3' }).refusal).toEqual({
      code: 'undo.result-kept',
      params: { path: '.claude/b.md', run: 'r1' },
    });
    expect(undo(held, { root, run: 'r1' })).toMatchObject({ run: 'u5', refusal: null });
    expect(file()).toBe('old\n');
  });

  it('undoes a stopped undo of an undo once the undo that restored nothing after it is undone', () => {
    const { root, held, file } = undos(['r1', 'u1', 'u2!', 'r1', 'u4']);
    expect(file()).toBe('old\n');
    expect(undo(held, { root, run: 'u3' })).toMatchObject({ run: 'u6', refusal: null });
    expect(file()).toBe('new\n');
  });
});

describe('undo of a replaced undo on two files', () => {
  it('undoes the undo of an undo while a stopped undo of r1 holds the file', () => {
    const { root, held, file } = undos(['r1', 'u1!', 'u1', 'r1!', 'u3']);
    expect(file()).toBe('old\n');
    expect(undo(held, { root, run: 'u5' })).toMatchObject({ run: 'u6', refusal: null });
    expect(file()).toBe('old\n');
  });

  // r1 replaces a.md and b.md. b.md is put back first, so the next undo of r1 and the undo of that one write a.md only.
  it.each([
    ['an undo of r1 stopped after its first write', true, ['r1', 'u2', 'u3'], 'u4'],
    ['the user', false, ['r1', 'u1', 'u2'], 'u3'],
  ] as const)('restores a.md and keeps a later edit of b.md, which %s put back', (_, stopped, ids, last) => {
    const { root, state } = project({ '.claude/a.md': 'a0\n', '.claude/b.md': 'b0\n' });
    const held = store(state, 'r1', 'u1', 'u2', 'u3', 'u4');
    apply(held, request(root, [replace('.claude/a.md', 'a0\n', 'a1\n'), replace('.claude/b.md', 'b0\n', 'b1\n')]));
    if (stopped) expect(() => undo(held, { root, run: 'r1' }, failAt('linked', 0))).toThrow('disk gone');
    else writeFileSync(join(root, '.claude/b.md'), 'b0\n');
    for (const id of ids.slice(0, 2)) expect(undo(held, { root, run: id }).refusal).toBeNull();
    expect(text(join(root, '.claude/a.md'))).toBe('a1\n');
    writeFileSync(join(root, '.claude/b.md'), 'mine\n');
    expect(undo(held, { root, run: ids[2] })).toMatchObject({ run: last, refusal: null });
    expect([text(join(root, '.claude/a.md')), text(join(root, '.claude/b.md'))]).toEqual(['a0\n', 'mine\n']);
  });
});

describe('undo matches files and runs as apply and the store do', () => {
  // Linux filesystems tell the two names apart, so apply never chains them as one file there.
  it.skipIf(process.platform === 'linux')('undoes two steps on one file named in two letter cases', () => {
    const { root, state } = project();
    const held = store(state, 'r1', 'u1');
    apply(held, request(root, [create('.claude/a.md', 'a\n'), replace('.claude/A.md', 'a\n', 'b\n')]));
    expect(undo(held, { root, run: 'r1' }).run).toBe('u1');
    expect(listing(root)).toEqual([]);
  });

  it('names the newest undo by the order it was recorded in, also when the clock went back', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const starts = new Map([
      ['r1', '2026-11-18T22:00:10.000Z'],
      ['u1', '2026-11-18T22:00:20.000Z'],
      ['u2', '2026-11-18T22:00:30.000Z'],
      ['u3', '2026-11-18T22:00:15.000Z'],
    ]);
    const ids = [...starts.keys()];
    let last = '';
    const clock = { now: () => new Date(starts.get(last) ?? 0), newRunId: () => (last = ids.shift() ?? '') };
    const held = storeWith(state, clock);
    apply(held, request(root, [replace('.claude/b.md', 'old\n', 'new\n')]));
    expect(['r1', 'u1', 'r1'].map((id) => undo(held, { root, run: id }).run)).toEqual(['u1', 'u2', 'u3']);
    expect(undo(held, { root, run: 'r1' }).refusal).toEqual({
      code: 'run.already-undone',
      params: { run: 'r1', by: 'u3' },
    });
  });
});

describe('undo of a chain on one file', () => {
  it('undoes a run again after its undo stopped between two steps on one file', () => {
    const { root, state } = project({ '.claude/b.md': 'A\n' });
    const held = store(state, 'r1', 'u1', 'u2');
    const plan = [
      replace('.claude/b.md', 'A\n', 'B\n'),
      replace('.claude/b.md', 'B\n', 'C\n'),
      replace('.claude/b.md', 'C\n', 'D\n'),
    ];
    apply(held, request(root, plan));
    expect(() => undo(held, { root, run: 'r1' }, failAt('written', 1))).toThrow('disk gone');
    expect(text(join(root, '.claude/b.md'))).toBe('B\n');
    expect(undo(held, { root, run: 'r1' })).toMatchObject({ run: 'u2', refusal: null });
    expect(text(join(root, '.claude/b.md'))).toBe('A\n');
  });

  it('restores nothing for a file the run created and deleted, also without its backup', () => {
    const { root, state } = project();
    const held = store(state, 'r1', 'u1');
    apply(held, request(root, [create('.claude/a.md', 'a\n'), remove('.claude/a.md', 'a\n')]));
    rmSync(join(state, 'backups/r1/1'));
    expect(undo(held, { root, run: 'r1' })).toMatchObject({ run: 'u1', refusal: null });
    expect(listing(root)).toEqual([]);
  });

  it('deletes a file the run created, deleted and created again, also without the backup of the delete', () => {
    const { root, state } = project();
    const held = store(state, 'r1', 'u1');
    apply(
      held,
      request(root, [create('.claude/a.md', 'a\n'), remove('.claude/a.md', 'a\n'), create('.claude/a.md', 'a\n')]),
    );
    rmSync(join(state, 'backups/r1/1'));
    const done = undo(held, { root, run: 'r1' });
    expect(done).toMatchObject({ run: 'u1', refusal: null });
    expect(done.plan?.operations.map((op) => op.kind)).toEqual(['delete']);
    expect(listing(root)).toEqual([]);
  });
});

describe('recovery of an undo', () => {
  it.each([
    ['temp-written', 'untouched'],
    ['set-aside', 'untouched'],
    ['linked', 'settled'],
    ['written', 'settled'],
  ] as const)(
    'settles an undo killed after %s like any run, and its undo leaves the run result',
    async (boundary, ended) => {
      const { root, state } = project({ '.claude/b.md': 'old\n' });
      const first = store(state);
      apply(first, request(root, [replace('.claude/b.md', 'old\n', 'new\n')]));
      release(first);
      await crash(state, { root, run: 'r1' }, boundary, 0);
      const result = undo(store(state, 'u2'), { root, run: 'u1' });
      expect([result.run, result.refusal, result.findings]).toEqual(['u2', null, [recovered('.claude/b.md', 'u1')]]);
      expect([run(state, 'u1'), undone(state, 'u1')]).toEqual([{ status: 'interrupted', steps: [ended] }, 'u2']);
      expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'new\n']);
    },
    20_000,
  );

  it('undoes an interrupted run once recovery settled it', async () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const plan = request(root, [create('.claude/a.md', 'a\n'), replace('.claude/b.md', 'old\n', 'new\n')]);
    await crash(state, plan, 'linked', 1);
    const result = undo(store(state, 'u1'), { root, run: 'r1' });
    expect([result.run, result.refusal, result.findings]).toEqual(['u1', null, [recovered('.claude/b.md')]]);
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'old\n']);
  }, 20_000);
});

describe('undo of a step that wrote nothing', () => {
  it('skips a step killed between its journal entry and its write, so a later edit of its file stays', async () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const plan = request(root, [create('.claude/a.md', 'a\n'), replace('.claude/b.md', 'old\n', 'new\n')]);
    await crash(state, plan, 'temp-written', 1);
    const held = store(state, 'u1');
    expect(apply(held, request(root, [])).findings).toEqual([recovered('.claude/b.md')]);
    writeFileSync(join(root, '.claude/b.md'), 'theirs\n');
    expect(undo(held, { root, run: 'r1' })).toMatchObject({ run: 'u1', refusal: null });
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'theirs\n']);
  }, 20_000);

  it('skips a step that stopped at a file another process wrote before the old one was set aside', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state, 'r1', 'u1');
    const race = (boundary: Boundary, position: number): void => {
      if (boundary === 'temp-written' && position === 1) writeFileSync(join(root, '.claude/b.md'), 'theirs\n');
    };
    apply(held, request(root, [create('.claude/a.md', 'a\n'), replace('.claude/b.md', 'old\n', 'new\n')]), race);
    expect(undo(held, { root, run: 'r1' })).toMatchObject({ run: 'u1', refusal: null });
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'theirs\n']);
  });
});

describe('undo of a delete', () => {
  // 0o640 differs from a new file's mode under the umasks 022 and 077.
  it.skipIf(process.platform === 'win32')('gives the file back its mode', () => {
    const { root, state } = project({ '.claude/p.md': 'private\n' });
    chmodSync(join(root, '.claude/p.md'), 0o640);
    const held = store(state, 'r1', 'u1');
    apply(held, request(root, [remove('.claude/p.md', 'private\n')]));
    expect(undo(held, { root, run: 'r1' }).refusal).toBeNull();
    expect(statSync(join(root, '.claude/p.md')).mode & 0o777).toBe(0o640);
  });
});

describe('undo of a create', () => {
  it.each([
    ['no file added', null, []],
    ['a file added in the inner folder', '.claude/skills/a/notes.md', ['skills']],
    ['a file added in the outer folder', '.claude/skills/notes.md', ['skills']],
  ] as const)('removes the folders it made while they hold nothing (%s)', (_case, added, left) => {
    const { root, state } = project();
    const held = store(state, 'r1', 'u1');
    apply(held, request(root, [create('.claude/skills/a/SKILL.md', 'a\n')]));
    if (added !== null) writeFileSync(join(root, added), 'mine\n');
    expect(undo(held, { root, run: 'r1' }).refusal).toBeNull();
    expect(listing(root)).toEqual(left);
    if (added !== null) expect(text(join(root, added))).toBe('mine\n');
  });

  it('removes a folder a later step made inside one an earlier step made', () => {
    const { root, state } = project();
    const held = store(state, 'r1', 'u1');
    apply(held, request(root, [create('.claude/skills/x.md', 'x\n'), create('.claude/skills/a/y.md', 'y\n')]));
    expect(undo(held, { root, run: 'r1' }).refusal).toBeNull();
    expect(listing(root)).toEqual([]);
  });

  it('removes no more folders than its path has, whatever the journal counts', () => {
    const { root, state } = project();
    const held = store(state, 'r1', 'u1');
    apply(held, request(root, [create('.claude/x.md', 'x\n')]));
    const db = new DatabaseSync(join(state, 'runs.sqlite'));
    db.exec('UPDATE operations SET madeFolders = 1000000');
    db.close();
    expect(undo(held, { root, run: 'r1' }).refusal).toBeNull();
    expect(readdirSync(root)).toEqual([]);
  });

  it('leaves a folder behind a link that took the place of a folder it made', () => {
    const { root, state } = project();
    const outside = fresh();
    mkdirSync(join(outside, 'a'));
    const held = store(state, 'r1', 'u1');
    apply(held, request(root, [create('.claude/skills/a/SKILL.md', 'a\n')]));
    const swap = (boundary: Boundary): void => {
      if (boundary !== 'written') return;
      renameSync(join(root, '.claude/skills'), join(root, '.claude/moved'));
      symlinkSync(outside, join(root, '.claude/skills'), 'junction');
    };
    expect(undo(held, { root, run: 'r1' }, swap).refusal).toBeNull();
    expect(readdirSync(outside)).toEqual(['a']);
  });
});

describe('undo of an edited journal', () => {
  it('leaves a folder outside the project in place for a journal path that climbs out of it', () => {
    const { root, state } = project();
    const outside = fresh();
    mkdirSync(join(outside, 'out'));
    const held = store(state, 'r1', 'u1');
    apply(held, request(root, [create('.claude/a.md', 'a\n')]));
    const db = new DatabaseSync(join(state, 'runs.sqlite'));
    db.prepare('UPDATE operations SET path = ?, madeFolders = 1').run(`.claude/../../${basename(outside)}/out/a.md`);
    db.close();
    expect(undo(held, { root, run: 'r1' }).refusal).toBeNull();
    expect(readdirSync(outside)).toEqual(['out']);
  });
});
