import {
  chmodSync,
  existsSync,
  linkSync as hardLink,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, type Boundary, precheck, StepFailed } from './apply.ts';
import type { RunStore } from './store.ts';
import {
  begin,
  crash,
  create,
  foldsCase,
  fresh,
  hash,
  listing,
  project,
  recovered,
  refused,
  refusedAt,
  remove,
  replace,
  request,
  run,
  runs,
  store,
  text,
  thrownBy,
} from './test-fixtures.ts';
import { undo } from './undo.ts';

// link() refused with `refuseLinks.code`, EPERM as on a filesystem without hard links, while `refuseLinks.on`.
const refuseLinks = vi.hoisted(() => ({ on: false, code: 'EPERM' }));
// Another process writes `racing.path` right before a rename or a new link puts something there.
const racing = vi.hoisted(() => ({ path: '' }));
// Every path reads as absent while `driveGone.on`, as on a drive that was unplugged; `calls` ends a walk without end.
const driveGone = vi.hoisted(() => ({ on: false, calls: 0 }));
// Sees each path right before unlinkSync removes it.
const unlinking = vi.hoisted(() => ({ check: (_path: string): void => undefined }));
vi.mock('node:fs', async (load) => {
  const fs = await load<typeof import('node:fs')>();
  const raceAt = (to: unknown): void => {
    if (to === racing.path) fs.writeFileSync(racing.path, 'theirs\n');
  };
  const linkSync: typeof fs.linkSync = (from, to) => {
    if (refuseLinks.on) {
      const { code } = refuseLinks;
      throw Object.assign(new Error(`${code}: link refused`), { code });
    }
    fs.linkSync(from, to);
  };
  const lstatSync = vi.fn(fs.lstatSync).mockImplementation((path, options) => {
    if (!driveGone.on) return fs.lstatSync(path, options);
    driveGone.calls += 1;
    if (driveGone.calls > 1000) throw new Error('lstat called without end');
    if (options?.throwIfNoEntry === false) return undefined;
    throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${String(path)}'`), { code: 'ENOENT' });
  });
  const renamed: typeof fs.renameSync = (from, to) => {
    raceAt(to);
    fs.renameSync(from, to);
  };
  const linked: typeof fs.symlinkSync = (target, path, type) => {
    raceAt(path);
    fs.symlinkSync(target, path, type);
  };
  const unlinkSync: typeof fs.unlinkSync = (path) => {
    unlinking.check(String(path));
    fs.unlinkSync(path);
  };
  return { ...fs, linkSync, lstatSync, renameSync: renamed, symlinkSync: linked, unlinkSync };
});

afterEach(() => {
  unlinking.check = () => undefined;
  refuseLinks.on = false;
  refuseLinks.code = 'EPERM';
  racing.path = '';
  driveGone.on = false;
  driveGone.calls = 0;
});

describe('apply writes', () => {
  it('writes each file as planned in both write roots, backs up what it replaces or deletes, and journals each step', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n', '.claude/c.md': 'gone\n' });
    const plan = [
      create('.claude/skills/a/SKILL.md', 'a\n'),
      replace('.claude/b.md', 'old\n', 'new\n'),
      remove('.claude/c.md', 'gone\n'),
      create('.cedarloom/workflows/a.json', '{}\n'),
    ];
    expect(apply(store(state), request(root, plan))).toEqual({ run: 'r1', refusal: null, findings: [] });
    expect(listing(root)).toEqual(['b.md', 'skills']);
    expect([text(join(root, '.claude/skills/a/SKILL.md')), text(join(root, '.claude/b.md'))]).toEqual(['a\n', 'new\n']);
    expect(readdirSync(join(state, 'backups/r1')).toSorted()).toEqual(['1', '2']);
    expect([text(join(state, 'backups/r1/1')), text(join(state, 'backups/r1/2'))]).toEqual(['old\n', 'gone\n']);
    expect(text(join(root, '.cedarloom/workflows/a.json'))).toBe('{}\n');
    expect(run(state, 'r1')).toEqual({ status: 'done', steps: ['done', 'done', 'done', 'done'] });
  });

  it('applies two edits of one file in order', () => {
    const { root, state } = project({ '.claude/b.md': 'v1\n' });
    const plan = [replace('.claude/b.md', 'v1\n', 'v2\n'), replace('.claude/b.md', 'v2\n', 'v3\n')];
    expect(apply(store(state), request(root, plan)).refusal).toBeNull();
    expect(text(join(root, '.claude/b.md'))).toBe('v3\n');
    expect([text(join(state, 'backups/r1/0')), text(join(state, 'backups/r1/1'))]).toEqual(['v1\n', 'v2\n']);
  });

  // Windows keeps only a read-only flag.
  it.skipIf(process.platform === 'win32')('keeps the mode of the file it replaces, not reduced by the umask', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    chmodSync(join(root, '.claude/b.md'), 0o666);
    const umask = process.umask(0o022);
    try {
      expect(apply(store(state), request(root, [replace('.claude/b.md', 'old\n', 'new\n')])).refusal).toBeNull();
    } finally {
      process.umask(umask);
    }
    expect(statSync(join(root, '.claude/b.md')).mode & 0o777).toBe(0o666);
  });
});

describe('apply checks the whole plan first', () => {
  it('does not overwrite a file changed between preview and apply, and records no run', () => {
    const { root, state } = project({ '.claude/b.md': 'theirs\n' });
    const plan = [replace('.claude/b.md', 'old\n', 'new\n')];
    expect(apply(store(state), request(root, plan))).toEqual(refusedAt('plan.file-changed', '.claude/b.md'));
    expect(text(join(root, '.claude/b.md'))).toBe('theirs\n');
    expect(runs(state)).toEqual([]);
  });

  it('refuses a chain whose second edit does not start where the first one ends', () => {
    const { root, state } = project({ '.claude/b.md': 'v1\n' });
    const plan = [replace('.claude/b.md', 'v1\n', 'v2\n'), replace('.claude/b.md', 'v1\n', 'v3\n')];
    expect(apply(store(state), request(root, plan))).toEqual(refusedAt('plan.file-changed', '.claude/b.md'));
    expect(text(join(root, '.claude/b.md'))).toBe('v1\n');
  });

  it('changes the files of one plan together: a refused operation stops the plan before anything changes', () => {
    const { root, state } = project({ '.claude/b.md': 'theirs\n' });
    const plan = [create('.claude/a.md', 'a\n'), replace('.claude/b.md', 'old\n', 'new\n')];
    expect(apply(store(state), request(root, plan))).toEqual(refusedAt('plan.file-changed', '.claude/b.md'));
    expect(listing(root)).toEqual(['b.md']);
    expect(runs(state)).toEqual([]);
  });

  it('refuses a plan whose new text does not match its hash', () => {
    const { root, state } = project();
    const plan = [create('.claude/a.md', 'a\n'), create('.claude/b.md', 'other\n', hash('b\n'))];
    expect(apply(store(state), request(root, plan))).toEqual(refusedAt('plan.text-mismatch', '.claude/b.md'));
    expect(listing(root)).toEqual([]);
  });

  it.each([
    'README.md',
    '.claude',
    '.cedarloom/workflows',
    '.cedarloom/state.json',
    '.claude/../README.md',
    '.claude/./a.md',
    '.claude//a.md',
    '/etc/passwd',
    '.claude/..\\README.md',
    '.claude/a.md:stream',
    '.claude/.git/config',
    '.cedarloom/workflows/.GIT/config',
    '.claude/skills/.git./HEAD',
    '.claude/skills/a/GIT~1/config',
  ])('refuses %s as outside the write roots before any write', (path) => {
    const { root, state } = project();
    const plan = [create('.claude/a.md', 'a\n'), create(path, 'x\n')];
    expect(apply(store(state), request(root, plan))).toEqual(refusedAt('plan.path-outside-roots', path));
    expect(listing(root)).toEqual([]);
  });
});

describe('apply writes only a text it reads back whole', () => {
  it('refuses a new text larger than 16 MiB, which apply would write but a later plan or undo would not read', () => {
    const { root, state } = project();
    const plan = [create('.claude/a.md', 'a'.repeat(16 * 1024 * 1024 + 1))];
    expect(apply(store(state), request(root, plan))).toEqual(refusedAt('plan.not-text', '.claude/a.md'));
    expect(listing(root)).toEqual([]);
  });
});

describe('apply checks the plan paths', () => {
  const long = `.claude/${'n'.repeat(180)}.md`;
  // 260 bytes in UTF-8, 130 UTF-16 units.
  const longFolder = `.claude/${'\u00e9'.repeat(130)}/a.md`;
  // 80 bytes, 240 once decomposed, as HFS+ stores it.
  const decomposed = `.claude/${'\u0390'.repeat(40)}.md`;
  // Past PATH_MAX of every platform, each name within 255 bytes.
  const deep = `.claude/${Array.from({ length: 22 }, () => 'n'.repeat(200)).join('/')}/a.md`;
  it.each([
    ['plan.path-nested', [create('.claude/a', 'a\n'), create('.claude/a/b', 'b\n')], '.claude/a/b'],
    ['plan.path-nested', [create('.claude/a/b', 'b\n'), create('.claude/a', 'a\n')], '.claude/a'],
    ['plan.name-too-long', [create('.claude/a.md', 'a\n'), create(long, 'x\n')], long],
    ['plan.name-too-long', [create('.claude/a.md', 'a\n'), create(longFolder, 'x\n')], longFolder],
    ['plan.name-too-long', [create('.claude/a.md', 'a\n'), create(decomposed, 'x\n')], decomposed],
    ['plan.name-too-long', [create('.claude/a.md', 'a\n'), create(deep, 'x\n')], deep],
    ['plan.name-not-portable', [create('.claude/a.md', 'a\n'), create('.claude/a?b.md', 'x\n')], '.claude/a?b.md'],
    ['plan.name-not-portable', [create('.claude/a.md', 'a\n'), create('.claude/a.md.', 'x\n')], '.claude/a.md.'],
    ['plan.name-not-portable', [create('.claude/a.md', 'a\n'), create('.claude/b. /c.md', 'x\n')], '.claude/b. /c.md'],
    ['plan.name-not-portable', [create('.claude/a.md', 'a\n'), create('.claude/aux.md', 'x\n')], '.claude/aux.md'],
    ['plan.name-not-portable', [create('.claude/a.md', 'a\n'), create('.claude/NUL', 'x\n')], '.claude/NUL'],
    ['plan.name-not-portable', [create('.claude/a.md', 'a\n'), create('.claude/com0.md', 'x\n')], '.claude/com0.md'],
    ['plan.name-not-portable', [create('.claude/a.md', 'a\n'), create('.claude/nul .md', 'x\n')], '.claude/nul .md'],
    ['plan.name-not-portable', [create('.claude/a.md', 'a\n'), create('.claude/CONOUT$', 'x\n')], '.claude/CONOUT$'],
  ] as const)('refuses with %s a plan path its steps could not write, before any write', (code, plan, path) => {
    const { root, state } = project();
    expect(apply(store(state), request(root, [...plan]))).toEqual(refusedAt(code, path));
    expect([listing(root), runs(state)]).toEqual([[], []]);
  });

  // Windows refuses to create the file the test starts from.
  it.skipIf(process.platform === 'win32')('deletes a file whose name Windows does not allow', () => {
    const { root, state } = project({ '.claude/a?b.md': 'a\n' });
    expect(apply(store(state), request(root, [remove('.claude/a?b.md', 'a\n')]))).toEqual({
      run: 'r1',
      refusal: null,
      findings: [],
    });
    expect(listing(root)).toEqual([]);
  });

  // "<" and U+0338 compose to U+226E, so a volume that normalizes reads both spellings as one file.
  it('refuses a replace that would write < or > as the plan spells it', () => {
    const { root, state } = project();
    writeFileSync(join(root, '.claude/≮.md'), 'a\n');
    const path = '.claude/≮.md';
    expect(apply(store(state), request(root, [replace(path, 'a\n', 'b\n')]))).toEqual(
      refusedAt('plan.name-not-portable', path),
    );
    expect(readdirSync(join(root, '.claude'))).toEqual(['≮.md']);
  });

  it('refuses a plan path through a file before any write', () => {
    const { root, state } = project({ '.claude/a.md': 'a\n' });
    const plan = [create('.claude/b.md', 'b\n'), create('.claude/a.md/c.md', 'c\n')];
    expect(apply(store(state), request(root, plan))).toEqual(refusedAt('plan.path-through-file', '.claude/a.md/c.md'));
    expect([listing(root), runs(state)]).toEqual([['a.md'], []]);
  });
});

// Whether a fresh folder of the volume reads two names as one file, as APFS does with ss.md, ß.md and ẞ.md.
const readsAsOne = (name: string, other: string) => (): boolean => {
  const folder = fresh();
  writeFileSync(join(folder, name), '');
  return existsSync(join(folder, other));
};
const foldsSharpS = readsAsOne('ss.md', 'ß.md');

describe('apply refuses two spellings of one path on every volume', () => {
  it.each([
    ['.claude/Foo.md', '.claude/foo.md', foldsCase],
    ['.claude/A/b.md', '.claude/a/b.md', foldsCase],
    ['.claude/ss.md', '.claude/ß.md', foldsSharpS],
    ['.claude/ẞ.md', '.claude/ß.md', readsAsOne('ẞ.md', 'ß.md')],
  ] as const)(
    'refuses %s beside %s, before any write: as changed on a volume that reads them as one file, else as a clash',
    (first, second, folds) => {
      const { root, state } = project();
      const expected = folds()
        ? refusedAt('plan.file-changed', second)
        : refused({ code: 'plan.spelling-clash', params: { path: second, other: first } });
      expect(apply(store(state), request(root, [create(first, 'a\n'), create(second, 'b\n')]))).toEqual(expected);
      expect([listing(root), runs(state)]).toEqual([[], []]);
    },
  );

  it('refuses with plan.path-nested two spellings of a file and a folder, before any write', () => {
    const { root, state } = project();
    const plan = [create('.claude/a', 'a\n'), create('.claude/A/b.md', 'b\n')];
    expect(apply(store(state), request(root, plan))).toEqual(refusedAt('plan.path-nested', '.claude/A/b.md'));
    expect([listing(root), runs(state)]).toEqual([[], []]);
  });

  it.skipIf(!foldsSharpS())('applies a chain over ss.md and ß.md on a volume that reads them as one file', () => {
    const { root, state } = project();
    const plan = [create('.claude/ss.md', 'a\n'), replace('.claude/ß.md', 'a\n', 'b\n')];
    expect(apply(store(state), request(root, plan))).toEqual({ run: 'r1', refusal: null, findings: [] });
    expect([listing(root).length, text(join(root, '.claude/ss.md'))]).toEqual([1, 'b\n']);
  });

  // Proves the rule only on a case-sensitive volume, as on Linux: elsewhere the two files are one, which reads as changed.
  it('refuses a chain over two spellings before any write where the second spelling is another file', () => {
    const { root, state } = project({ '.claude/B.md': 'v1\n', '.claude/b.md': 'other\n' });
    const before = listing(root);
    const plan = [replace('.claude/B.md', 'v1\n', 'v2\n'), replace('.claude/b.md', 'v2\n', 'v3\n')];
    expect(apply(store(state), request(root, plan)).run).toBeNull();
    expect([listing(root), runs(state)]).toEqual([before, []]);
  });
});

describe('apply probes two spellings in a private folder', () => {
  // A folder mode keeps neither root nor any process on Windows out.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses a folder the spelling probe may not write, before any write',
    () => {
      const { root, state } = project({ '.claude/B.md': 'v1\n' });
      const folder = join(root, '.claude');
      const plan = [replace('.claude/B.md', 'v1\n', 'v2\n'), replace('.claude/b.md', 'v2\n', 'v3\n')];
      chmodSync(folder, 0o500);
      try {
        expect(apply(store(state), request(root, plan))).toEqual(
          refused({ code: 'plan.folder-denied', params: { path: '.claude/b.md', denied: '.claude' } }),
        );
        expect([listing(root), runs(state)]).toEqual([['B.md'], []]);
      } finally {
        chmodSync(folder, 0o700);
      }
    },
  );

  // Needs a volume that reads both folder names as one and a folder mode that keeps the process out, which Windows lacks.
  it.skipIf(!foldsCase() || process.platform === 'win32' || process.getuid?.() === 0)(
    'probes no spelling where the names below the shared folder are equal',
    () => {
      const { root } = project();
      const folder = join(root, '.claude/Sub');
      mkdirSync(folder);
      writeFileSync(join(folder, 'x.md'), 'v1\n');
      const plan = [replace('.claude/Sub/x.md', 'v1\n', 'v2\n'), replace('.claude/sub/x.md', 'v2\n', 'v3\n')];
      chmodSync(folder, 0o500);
      try {
        expect(precheck(root, plan, false)).toBeUndefined();
      } finally {
        chmodSync(folder, 0o700);
      }
    },
  );
});

describe('apply keeps to the write roots', () => {
  it('refuses a folder link on the way, and writes nothing through it', () => {
    const { root, state } = project();
    const outside = fresh();
    // A junction on Windows, where a folder link needs no privilege.
    symlinkSync(outside, join(root, '.claude/skills'), 'junction');
    const plan = [create('.claude/skills/a/SKILL.md', 'a\n')];
    expect(apply(store(state), request(root, plan))).toEqual(refusedAt('plan.symlink', '.claude/skills'));
    expect(readdirSync(outside)).toEqual([]);
  });

  // Windows creates a file link only with a privilege.
  it.skipIf(process.platform === 'win32')('refuses a link at the path, also a dangling one, judged as a link', () => {
    const { root, state } = project();
    const outside = join(fresh(), 'target.md');
    symlinkSync(outside, join(root, '.claude/a.md'));
    const held = store(state);
    for (const operation of [create('.claude/a.md', 'a\n'), remove('.claude/a.md', 'a\n')]) {
      expect(apply(held, request(root, [operation]))).toEqual(refusedAt('plan.symlink', '.claude/a.md'));
    }
    expect(existsSync(outside)).toBe(false);
  });

  it('stops the run at a folder swapped for a link during the run', () => {
    const { root, state } = project();
    const outside = fresh();
    const plan = [create('.claude/a.md', 'a\n'), create('.claude/skills/b/SKILL.md', 'b\n')];
    const swap = (boundary: Boundary, position: number): void => {
      if (boundary === 'written' && position === 0) symlinkSync(outside, join(root, '.claude/skills'), 'junction');
    };
    expect(apply(store(state), request(root, plan), swap)).toEqual(refusedAt('plan.symlink', '.claude/skills', 'r1'));
    expect(readdirSync(outside)).toEqual([]);
    expect(run(state, 'r1')).toEqual({ status: 'failed', steps: ['done', 'untouched'] });
  });
});

describe('apply stops the run at a path denied during the run', () => {
  // A mode keeps neither root nor any process on Windows out.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'stops the run at the file it replaces denied during the run',
    () => {
      const { root, state } = project({ '.claude/b.md': 'old\n' });
      const deny = (boundary: Boundary, position: number): void => {
        if (boundary === 'written' && position === 0) chmodSync(join(root, '.claude/b.md'), 0o000);
      };
      const plan = [create('.claude/a.md', 'a\n'), replace('.claude/b.md', 'old\n', 'new\n')];
      try {
        expect(apply(store(state), request(root, plan), deny)).toEqual(
          refused({ code: 'plan.folder-denied', params: { path: '.claude/b.md', denied: '.claude/b.md' } }, 'r1'),
        );
      } finally {
        chmodSync(join(root, '.claude/b.md'), 0o700);
      }
      expect([text(join(root, '.claude/b.md')), run(state, 'r1')]).toEqual([
        'old\n',
        { status: 'failed', steps: ['done', 'untouched'] },
      ]);
    },
  );
});

describe('apply stops a step', () => {
  it.each([
    ['replaced', replace('.claude/b.md', 'old\n', 'new\n')],
    ['created', create('.claude/b.md', 'new\n')],
  ])(
    'keeps a file another process wrote while the step ran, leaves no temporary file, and fails the run (%s)',
    (_kind, operation) => {
      const { root, state } = project(operation.kind === 'replace' ? { '.claude/b.md': 'old\n' } : {});
      const race = (boundary: Boundary): void => {
        if (boundary === 'temp-written') writeFileSync(join(root, '.claude/b.md'), 'theirs\n');
      };
      expect(apply(store(state), request(root, [operation]), race)).toEqual(
        refusedAt('plan.file-changed', '.claude/b.md', 'r1'),
      );
      expect(listing(root)).toEqual(['b.md']);
      expect(text(join(root, '.claude/b.md'))).toBe('theirs\n');
      expect(run(state, 'r1')).toEqual({ status: 'failed', steps: ['untouched'] });
    },
  );

  it('stops the step before any write when the backup fails', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    // A file where the backups folder goes.
    writeFileSync(join(state, 'backups'), '');
    const plan = [replace('.claude/b.md', 'old\n', 'new\n')];
    expect(apply(store(state), request(root, plan))).toEqual(
      refused({ code: 'apply.backup-failed', params: { run: 'r1', path: '.claude/b.md' } }, 'r1'),
    );
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'old\n']);
    expect(run(state, 'r1')).toEqual({ status: 'failed', steps: ['untouched'] });
  });
});

// The next apply settles the run left behind, with nothing to report, and its step was never started.
const nextApplyRuns = (held: RunStore, root: string, state: string): void => {
  expect(apply(held, request(root, []))).toEqual({ run: null, refusal: null, findings: [] });
  expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['pending'] });
};

// Past the check of the volume, as when the project moved to another one during the run.
const linksGone = (boundary: Boundary): void => {
  if (boundary === 'temp-written') refuseLinks.on = true;
};

const failAtSetAside = (boundary: Boundary): void => {
  if (boundary === 'set-aside') throw new Error('disk gone');
};

describe('apply stops a run', () => {
  it('puts the files in order, ends the run and names it with what recovery settled before and after, when a step throws', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state, 'r0', 'r1');
    begin(held, root, '.claude/a.md');
    writeFileSync(join(root, '.claude/.a.md.cedarloom-r0-0'), 'a\n');
    const thrown = thrownBy(() =>
      apply(held, request(root, [replace('.claude/b.md', 'old\n', 'new\n')]), failAtSetAside),
    );
    expect(thrown).toBeInstanceOf(StepFailed);
    expect(thrown).toMatchObject({
      run: 'r1',
      findings: [recovered('.claude/a.md', 'r0'), recovered('.claude/b.md')],
      cause: new Error('disk gone'),
    });
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'old\n']);
    expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['untouched'] });
  });

  it('leaves no half-written backup and no temporary file when the copy fails midway', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    // A folder where the backup is renamed in, so the copy fails after its temporary file is written.
    mkdirSync(join(state, 'backups/r1/0'), { recursive: true });
    const plan = [replace('.claude/b.md', 'old\n', 'new\n')];
    expect(apply(store(state), request(root, plan)).refusal).toEqual({
      code: 'apply.backup-failed',
      params: { run: 'r1', path: '.claude/b.md' },
    });
    expect([readdirSync(join(state, 'backups/r1')), readdirSync(join(state, 'backups/r1/0'))]).toEqual([['0'], []]);
    expect(text(join(root, '.claude/b.md'))).toBe('old\n');
  });

  it('stops the run when the written file does not hash as planned', () => {
    const { root, state } = project();
    const tamper = (boundary: Boundary): void => {
      if (boundary === 'linked') writeFileSync(join(root, '.claude/a.md'), 'other\n');
    };
    expect(apply(store(state), request(root, [create('.claude/a.md', 'a\n')]), tamper)).toEqual(
      refused({ code: 'apply.write-mismatch', params: { run: 'r1', path: '.claude/a.md' } }, 'r1'),
    );
    expect(run(state, 'r1')).toEqual({ status: 'failed', steps: ['failed'] });
  });
});

// Recovery reads a temporary file left without an aside as a step that kept the old file.
describe('apply drops the temporary file before the old one', () => {
  it.each([
    ['linked its file', false],
    ['met a file another process wrote after the old one was set aside', true],
  ])('when the step %s', (_case, race) => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const temp = join(root, '.claude/.b.md.cedarloom-r1-0');
    const tempLeft: boolean[] = [];
    unlinking.check = (path) => {
      if (path === `${temp}.old`) tempLeft.push(existsSync(temp));
    };
    const at = (boundary: Boundary): void => {
      if (race && boundary === 'set-aside') writeFileSync(join(root, '.claude/b.md'), 'theirs\n');
    };
    apply(store(state), request(root, [replace('.claude/b.md', 'old\n', 'new\n')]), at);
    expect(tempLeft).toEqual([false]);
  });
});

describe('apply after a step throws', () => {
  it('puts the old file back where the filesystem refuses hard links, and the next apply runs', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state);
    expect(() => apply(held, request(root, [replace('.claude/b.md', 'old\n', 'new\n')]), linksGone)).toThrow('EPERM');
    refuseLinks.on = false;
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'old\n']);
    nextApplyRuns(held, root, state);
  });

  // A folder mode keeps neither root nor any process on Windows out.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'names a run the recovery after the step could not settle',
    () => {
      const { root, state } = project({ '.claude/c.md': 'gone\n' });
      const folder = join(root, '.claude');
      const readOnly = (boundary: Boundary): void => {
        if (boundary !== 'set-aside') return;
        chmodSync(folder, 0o500);
        throw new Error('disk gone');
      };
      let thrown: unknown;
      try {
        thrown = thrownBy(() => apply(store(state), request(root, [remove('.claude/c.md', 'gone\n')]), readOnly));
      } finally {
        chmodSync(folder, 0o700);
      }
      expect(thrown).toMatchObject({
        run: 'r1',
        findings: [{ code: 'recovery.skipped', severity: 'warning', params: { run: 'r1', path: '.claude/c.md' } }],
        cause: new Error('disk gone'),
      });
    },
  );
});

describe('apply puts the old file back only to a free path', () => {
  it('keeps a file another process wrote at the path where the filesystem refuses hard links to put the old one back', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const theirs = (boundary: Boundary): void => {
      linksGone(boundary);
      if (boundary === 'set-aside') writeFileSync(join(root, '.claude/b.md'), 'theirs\n');
    };
    expect(() => apply(store(state), request(root, [replace('.claude/b.md', 'old\n', 'new\n')]), theirs)).toThrow(
      'EPERM',
    );
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'theirs\n']);
    expect([text(join(state, 'backups/r1/0')), run(state, 'r1')]).toEqual([
      'old\n',
      { status: 'interrupted', steps: ['settled'] },
    ]);
  });
});

describe('apply on a volume without hard links, and a link put back', () => {
  it.each(['EPERM', 'EISDIR'])(
    'refuses a volume whose link probe fails with %s before any write, and leaves no probe',
    (code) => {
      const { root, state } = project({ '.claude/b.md': 'old\n' });
      refuseLinks.on = true;
      refuseLinks.code = code;
      expect(apply(store(state), request(root, [replace('.claude/b.md', 'old\n', 'new\n')]))).toEqual(
        refusedAt('apply.no-hard-links', '.claude/b.md'),
      );
      expect([listing(root), text(join(root, '.claude/b.md')), runs(state)]).toEqual([['b.md'], 'old\n', []]);
    },
  );

  // Its undo links the file back in.
  it('refuses a plan that only deletes on a volume without hard links', () => {
    const { root, state } = project({ '.claude/c.md': 'gone\n' });
    refuseLinks.on = true;
    expect(apply(store(state), request(root, [remove('.claude/c.md', 'gone\n')]))).toEqual(
      refusedAt('apply.no-hard-links', '.claude/c.md'),
    );
    expect([listing(root), text(join(root, '.claude/c.md')), runs(state)]).toEqual([['c.md'], 'gone\n', []]);
  });

  // Windows makes a file link only with a privilege.
  it.skipIf(process.platform === 'win32')(
    'keeps a file another process writes while a link swapped in during the step goes back',
    () => {
      const { root, state } = project({ '.claude/b.md': 'old\n' });
      const path = join(root, '.claude/b.md');
      const swap = (boundary: Boundary): void => {
        if (boundary !== 'temp-written') return;
        rmSync(path);
        symlinkSync('elsewhere.md', path);
        racing.path = path;
      };
      expect(apply(store(state), request(root, [replace('.claude/b.md', 'old\n', 'new\n')]), swap)).toEqual(
        refusedAt('plan.file-changed', '.claude/b.md', 'r1'),
      );
      expect(text(path)).toBe('theirs\n');
    },
  );
});

describe('apply probes the volume', () => {
  it('throws a link error that does not mean a volume without hard links, before any write', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    refuseLinks.on = true;
    refuseLinks.code = 'EIO';
    expect(() => apply(store(state), request(root, [replace('.claude/b.md', 'old\n', 'new\n')]))).toThrow('EIO');
    expect([listing(root), text(join(root, '.claude/b.md')), runs(state)]).toEqual([['b.md'], 'old\n', []]);
  });

  it('throws ENOENT when nothing on the way to a plan path exists, before a run is recorded', () => {
    const { root, state } = project();
    const held = store(state);
    driveGone.on = true;
    expect(() => apply(held, request(root, [create('.claude/a.md', 'a\n')]))).toThrow('ENOENT');
    driveGone.on = false;
    expect([listing(root), runs(state)]).toEqual([[], []]);
  });

  it('throws ENOENT for a removed project root, before a run is recorded, and probes nothing above it', () => {
    const above = fresh();
    const root = join(above, 'project');
    const state = fresh();
    expect(() => apply(store(state), request(root, [create('.claude/a.md', 'a\n')]))).toThrow('ENOENT');
    expect([readdirSync(above), runs(state)]).toEqual([[], []]);
  });

  // A mode keeps neither root nor any process on Windows out.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([
    ['a folder the link probe may not write', '.claude', 0o500, create('.claude/a.md', 'a\n')],
    ['a file it may not read', '.claude/b.md', 0o000, replace('.claude/b.md', 'old\n', 'new\n')],
  ] as const)('refuses %s, before any write', (_case, denied, mode, operation) => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    chmodSync(join(root, denied), mode);
    try {
      expect(apply(store(state), request(root, [operation]))).toEqual(
        refused({ code: 'plan.folder-denied', params: { path: operation.path, denied } }),
      );
    } finally {
      chmodSync(join(root, denied), 0o700);
    }
    expect([listing(root), runs(state)]).toEqual([['b.md'], []]);
  });
});

describe('apply makes no folder above the project', () => {
  it('stops a step whose project root was removed during the run, and makes it not again', () => {
    const { root, state } = project();
    const removeRoot = (boundary: Boundary, position: number): void => {
      if (boundary === 'written' && position === 0) rmSync(root, { recursive: true });
    };
    const plan = [create('.claude/a.md', 'a\n'), create('.claude/skills/b.md', 'b\n')];
    const thrown = thrownBy(() => apply(store(state), request(root, plan), removeRoot));
    expect(thrown).toMatchObject({ run: 'r1', cause: { code: 'ENOENT' } });
    expect(existsSync(root)).toBe(false);
  });
});

describe('apply after a step and the removal of its temporary file throw', () => {
  // A folder mode keeps neither root nor any process on Windows out.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('throws the step error first', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const folder = join(root, '.claude');
    const readOnly = (boundary: Boundary): void => {
      if (boundary !== 'temp-written') return;
      chmodSync(folder, 0o500);
      throw new Error('disk gone');
    };
    let thrown: unknown;
    try {
      thrown = thrownBy(() =>
        apply(store(state), request(root, [replace('.claude/b.md', 'old\n', 'new\n')]), readOnly),
      );
    } finally {
      chmodSync(folder, 0o700);
    }
    const cause = thrown instanceof StepFailed ? thrown.cause : thrown;
    expect(cause instanceof AggregateError ? cause.errors : cause).toMatchObject([
      new Error('disk gone'),
      { code: 'EACCES' },
    ]);
  });
});

describe('apply after a step and its recovery throw', () => {
  it('throws the step error first when the recovery after it fails too', () => {
    const { root, state } = project({ '.claude/c.md': 'gone\n' });
    const held = store(state);
    const journalGone = (boundary: Boundary): void => {
      if (boundary !== 'set-aside') return;
      vi.spyOn(held, 'unfinished').mockImplementation(() => {
        throw new Error('journal gone');
      });
      throw new Error('disk gone');
    };
    const thrown = thrownBy(() => apply(held, request(root, [remove('.claude/c.md', 'gone\n')]), journalGone));
    const cause = thrown instanceof StepFailed ? thrown.cause : thrown;
    expect(cause instanceof AggregateError ? cause.errors : cause).toEqual([
      new Error('disk gone'),
      new Error('journal gone'),
    ]);
  });
});

describe('apply ends a run', () => {
  it('ends the run with its last step, or leaves both open', () => {
    const { root, state } = project();
    const held = store(state);
    const db = new DatabaseSync(join(state, 'runs.sqlite'));
    db.exec(`CREATE TRIGGER no_end BEFORE UPDATE OF status ON runs BEGIN SELECT RAISE(ABORT, 'no end'); END`);
    db.close();
    expect(() => apply(held, request(root, [create('.claude/a.md', 'a\n')]))).toThrow(StepFailed);
    expect(run(state, 'r1')).toEqual({ status: 'running', steps: ['pending'] });
  });
});

describe('recovery', () => {
  it.each([
    ['temp-written', 'old\n', 'untouched'],
    ['set-aside', 'old\n', 'untouched'],
    ['linked', 'new\n', 'settled'],
    ['written', 'new\n', 'settled'],
  ] as const)(
    'settles a replace killed after %s, and the run stays listed as interrupted',
    async (boundary, left, ended) => {
      const { root, state } = project({ '.claude/b.md': 'old\n' });
      const plan = request(root, [create('.claude/a.md', 'a\n'), replace('.claude/b.md', 'old\n', 'new\n')]);
      await crash(state, plan, boundary, 1);
      expect(runs(state)).toEqual(['interrupted']);
      const held = store(state);
      expect(apply(held, request(root, []))).toEqual({
        run: null,
        refusal: null,
        findings: [recovered('.claude/b.md')],
      });
      expect(listing(root)).toEqual(['a.md', 'b.md']);
      expect(text(join(root, '.claude/b.md'))).toBe(left);
      expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['done', ended] });
      expect(apply(held, request(root, [])).findings).toEqual([]);
    },
    20_000,
  );
});

describe('recovery of a delete and of a step not started', () => {
  it.each([
    ['set-aside', 'gone\n', 'untouched'],
    ['written', null, 'settled'],
  ] as const)(
    'settles a delete killed after %s',
    async (boundary, left, ended) => {
      const { root, state } = project({ '.claude/c.md': 'gone\n' });
      await crash(state, request(root, [remove('.claude/c.md', 'gone\n')]), boundary, 0);
      expect(apply(store(state), request(root, [])).findings).toEqual([recovered('.claude/c.md')]);
      expect([listing(root), text(join(root, '.claude/c.md'))]).toEqual([left === null ? [] : ['c.md'], left]);
      expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: [ended] });
    },
    20_000,
  );

  it('settles only the step that ran when a later one would leave the same file', async () => {
    const { root, state } = project();
    const plan = request(root, [create('.claude/a.md', 'a\n'), remove('.claude/a.md', 'a\n')]);
    await crash(state, plan, 'temp-written', 0);
    expect(apply(store(state), request(root, [])).findings).toEqual([recovered('.claude/a.md')]);
    expect([listing(root), run(state, 'r1')]).toEqual([[], { status: 'interrupted', steps: ['untouched', 'pending'] }]);
  }, 20_000);

  it('settles a run whose temporary name is too long to exist, so the next apply runs', () => {
    const { root, state } = project();
    const held = store(state);
    begin(held, root, `.claude/${'n'.repeat(250)}.md`);
    nextApplyRuns(held, root, state);
  });

  it('settles a run whose path is too long to exist, so the next apply runs', () => {
    const { root, state } = project();
    const held = store(state);
    begin(held, root, `.claude/${'n'.repeat(256)}/a.md`);
    nextApplyRuns(held, root, state);
  });

  it('throws what keeps it from settling a step other than a refusing filesystem', () => {
    const { root, state } = project();
    const held = store(state);
    begin(held, root, '.claude/b.md');
    mkdirSync(join(root, '.claude/.b.md.cedarloom-r1-0'));
    expect(() => apply(held, request(root, []))).toThrow(expect.objectContaining({ code: 'ERR_FS_EISDIR' }));
  });

  it('leaves a step the run never started pending, and reports nothing for it', async () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const plan = request(root, [create('.claude/a.md', 'a\n'), replace('.claude/b.md', 'old\n', 'new\n')]);
    await crash(state, plan, 'written', 0);
    expect(apply(store(state), request(root, [])).findings).toEqual([recovered('.claude/a.md')]);
    expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['settled', 'pending'] });
    expect(text(join(root, '.claude/b.md'))).toBe('old\n');
  }, 20_000);
});

describe('recovery of an aside', () => {
  // The step found another process's file where it expected old, and its put back of that file stopped after the link.
  it('drops an aside that is the file at the path, as a put back stopped after its link leaves it', () => {
    const { root, state } = project({ '.claude/b.md': 'theirs\n' });
    const held = store(state);
    begin(held, root, '.claude/b.md', hash('old\n'));
    hardLink(join(root, '.claude/b.md'), join(root, '.claude/.b.md.cedarloom-r1-0.old'));
    expect(apply(held, request(root, [])).findings).toEqual([recovered('.claude/b.md')]);
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'theirs\n']);
    expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['untouched'] });
  });
});

describe('recovery of a step that changed its path, then edited', () => {
  // A replace that dropped its temporary file and stopped before it dropped the old one.
  it('settles a replace whose aside holds the old text, without a temporary file', () => {
    const { root, state } = project({ '.claude/b.md': 'theirs\n' });
    const held = store(state);
    begin(held, root, '.claude/b.md', hash('old\n'));
    writeFileSync(join(root, '.claude/.b.md.cedarloom-r1-0.old'), 'old\n');
    expect(apply(held, request(root, [])).findings).toEqual([recovered('.claude/b.md')]);
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'theirs\n']);
    expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['settled'] });
  });
});

describe('recovery blocked by the filesystem', () => {
  // A folder mode keeps neither root nor any process on Windows out.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([0o500, 0o000])(
    'reports a run it cannot settle in a folder of mode %o, and refuses every change until it is settled',
    (mode) => {
      const { root, state } = project();
      const held = store(state, 'r1', 'r2');
      expect(apply(held, request(root, [create('.cedarloom/workflows/a.json', '{}\n')])).refusal).toBeNull();
      begin(held, root, '.claude/b.md');
      writeFileSync(join(root, '.claude/.b.md.cedarloom-r2-0'), 'a\n');
      const folder = join(root, '.claude');
      const params = { run: 'r2', path: '.claude/b.md' };
      const skipped = { code: 'recovery.skipped', severity: 'warning', params };
      const unsettled = { code: 'apply.unsettled', params };
      chmodSync(folder, mode);
      try {
        const plan = request(root, [create('.cedarloom/workflows/c.json', '{}\n')]);
        expect(apply(held, plan)).toEqual({ run: null, refusal: unsettled, findings: [skipped] });
        expect(undo(held, { root, run: 'r1' })).toMatchObject({ refusal: unsettled, findings: [skipped] });
        expect(undo(held, { root, run: 'r2' }).refusal).toEqual(unsettled);
      } finally {
        chmodSync(folder, 0o700);
      }
      expect(text(join(root, '.cedarloom/workflows/c.json'))).toBeNull();
      expect(apply(held, request(root, [])).findings).toEqual([recovered('.claude/b.md', 'r2')]);
    },
  );
});
