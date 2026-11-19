import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanOperation, Refusal } from '@cedarloom/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Applied, type ApplyRequest, apply, type Boundary } from './apply.ts';
import { openRunView, openStore, type RunStore, type RunView } from './store.ts';
import { type UndoRequest, undo } from './undo.ts';

// link() refused as on a filesystem without hard links, such as exFAT, while `refuseLinks.on`.
const refuseLinks = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs', async (load) => {
  const fs = await load<typeof import('node:fs')>();
  const linkSync: typeof fs.linkSync = (from, to) => {
    if (refuseLinks.on) throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
    fs.linkSync(from, to);
  };
  return { ...fs, linkSync };
});

const folders: string[] = [];
const opened: { close(): void }[] = [];
afterEach(() => {
  for (const item of opened.splice(0)) item.close();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cedarloom-apply-'));
  folders.push(dir);
  return dir;
};

// A project with `.claude/` holding these files, and a store folder beside it.
const project = (files: Record<string, string> = {}): { root: string; state: string } => {
  const root = fresh();
  mkdirSync(join(root, '.claude'));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return { root, state: fresh() };
};

// The store gives the run ids in order, then r1.
const store = (state: string, ...ids: string[]): RunStore => {
  const clock = { now: () => new Date('2026-11-18T22:17:39.123Z'), newRunId: () => ids.shift() ?? 'r1' };
  const result = openStore(state, clock);
  if (!result.ok) throw new Error(result.refusal.code);
  opened.push(result.value);
  return result.value;
};

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const create = (path: string, after: string, afterHash = hash(after)): PlanOperation => ({
  kind: 'create',
  path,
  beforeHash: null,
  afterHash,
  before: null,
  after,
});
const replace = (path: string, before: string, after: string): PlanOperation => ({
  kind: 'replace',
  path,
  beforeHash: hash(before),
  afterHash: hash(after),
  before,
  after,
});
const remove = (path: string, before: string): PlanOperation => ({
  kind: 'delete',
  path,
  beforeHash: hash(before),
  afterHash: null,
  before,
  after: null,
});

const request = (root: string, operations: PlanOperation[]): ApplyRequest => ({
  root,
  plan: { planHash: 'a'.repeat(64), operations, skipped: [] },
  run: { kind: 'apply', action: 'workflow.new', subject: 'demo', undoes: null, generatedFrom: [] },
});

const view = (state: string): RunView => {
  const opening = openRunView(state);
  if (!opening.ok) throw new Error(opening.refusal.code);
  opened.push(opening.value);
  return opening.value;
};

const run = (state: string, id: string) => {
  const found = view(state).run(id);
  if (!found.ok || found.value === undefined) throw new Error(`no run ${id}`);
  return { status: found.value.status, steps: found.value.operations.map((operation) => operation.status) };
};

const runs = (state: string): string[] => {
  const found = view(state).runs();
  if (!found.ok) throw new Error(found.refusal.code);
  return found.value.map((summary) => summary.status);
};

const text = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);
const listing = (root: string): string[] => readdirSync(join(root, '.claude')).toSorted();
const refused = (refusal: Refusal, id: string | null = null): Applied => ({ run: id, refusal, findings: [] });
const recovered = (path: string, id = 'r1') => ({
  code: 'apply.recovered',
  severity: 'info',
  params: { run: id, path },
});
const refusedAt = (code: Refusal['code'], path: string, id: string | null = null): Applied =>
  refused({ code, params: { path } }, id);

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

describe('apply checks the plan paths', () => {
  const long = `.claude/${'n'.repeat(180)}.md`;
  it.each([
    ['plan.file-changed', [create('.claude/a', 'a\n'), create('.claude/a/b', 'b\n')], '.claude/a/b'],
    ['plan.file-changed', [create('.claude/a/b', 'b\n'), create('.claude/a', 'a\n')], '.claude/a'],
    ['plan.name-too-long', [create('.claude/a.md', 'a\n'), create(long, 'x\n')], long],
  ] as const)('refuses with %s a plan path its steps could not write, before any write', (code, plan, path) => {
    const { root, state } = project();
    expect(apply(store(state), request(root, [...plan]))).toEqual(refusedAt(code, path));
    expect([listing(root), runs(state)]).toEqual([[], []]);
  });
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
    expect(run(state, 'r1')).toEqual({ status: 'failed', steps: ['done', 'failed'] });
  });
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
      expect(run(state, 'r1')).toEqual({ status: 'failed', steps: ['failed'] });
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
    expect(run(state, 'r1')).toEqual({ status: 'failed', steps: ['failed'] });
  });
});

// The next apply settles the run left behind, with nothing to report, and its step was never started.
const nextApplyRuns = (held: RunStore, root: string, state: string): void => {
  expect(apply(held, request(root, []))).toEqual({ run: null, refusal: null, findings: [] });
  expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['pending'] });
};

const failAtSetAside = (boundary: Boundary): void => {
  if (boundary === 'set-aside') throw new Error('disk gone');
};

describe('apply stops a run', () => {
  it('puts the files in order and ends the run when a step throws', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state);
    expect(() => apply(held, request(root, [replace('.claude/b.md', 'old\n', 'new\n')]), failAtSetAside)).toThrow(
      'disk gone',
    );
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'old\n']);
    expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['settled'] });
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

describe('apply after a step throws', () => {
  it('puts the old file back where the filesystem refuses hard links, and the next apply runs', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state);
    refuseLinks.on = true;
    try {
      expect(() => apply(held, request(root, [replace('.claude/b.md', 'old\n', 'new\n')]))).toThrow('EPERM');
    } finally {
      refuseLinks.on = false;
    }
    expect([listing(root), text(join(root, '.claude/b.md'))]).toEqual([['b.md'], 'old\n']);
    nextApplyRuns(held, root, state);
  });

  // A folder mode does not keep a process out on Windows.
  it.skipIf(process.platform === 'win32')('throws the step error first when the recovery after it fails too', () => {
    const { root, state } = project({ '.claude/c.md': 'gone\n' });
    const folder = join(root, '.claude');
    const readOnly = (boundary: Boundary): void => {
      if (boundary !== 'set-aside') return;
      chmodSync(folder, 0o500);
      throw new Error('disk gone');
    };
    let thrown: unknown;
    try {
      apply(store(state), request(root, [remove('.claude/c.md', 'gone\n')]), readOnly);
    } catch (error) {
      thrown = error;
    } finally {
      chmodSync(folder, 0o700);
    }
    expect(thrown instanceof AggregateError ? thrown.errors[0] : thrown).toEqual(new Error('disk gone'));
  });
});

// Another process that applies the plan as run r1, or undoes the run as run u1, and kills itself at `boundary` of the
// operation at `position`.
const crash = async (
  state: string,
  plan: ApplyRequest | UndoRequest,
  boundary: Boundary,
  position: number,
): Promise<void> => {
  const script = `
    import { apply } from ${JSON.stringify(new URL('apply.ts', import.meta.url).href)};
    import { undo } from ${JSON.stringify(new URL('undo.ts', import.meta.url).href)};
    import { openStore } from ${JSON.stringify(new URL('store.ts', import.meta.url).href)};
    const [state, plan, boundary, position] = process.argv.slice(1);
    const request = JSON.parse(plan);
    const id = 'plan' in request ? 'r1' : 'u1';
    const store = openStore(state, { now: () => new Date('2026-11-18T22:00:00.000Z'), newRunId: () => id });
    if (!store.ok) throw new Error(store.refusal.code);
    ('plan' in request ? apply : undo)(store.value, request, (at, index) => {
      if (at === boundary && index === Number(position)) process.kill(process.pid, 'SIGKILL');
    });
    process.stdout.write('not killed');
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', script, state, JSON.stringify(plan), boundary, String(position)],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  await once(child, 'exit');
  expect(out).toBe('');
};

describe('recovery', () => {
  it.each([
    ['temp-written', 'old\n'],
    ['set-aside', 'old\n'],
    ['linked', 'new\n'],
    ['written', 'new\n'],
  ] as const)(
    'settles a replace killed after %s, and the run stays listed as interrupted',
    async (boundary, left) => {
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
      expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['done', 'settled'] });
      expect(apply(held, request(root, [])).findings).toEqual([]);
    },
    20_000,
  );
});

// A run recorded as running whose one step, a create at `path`, never started.
const begin = (held: RunStore, root: string, path: string): void => {
  const operations = [{ kind: 'create', path, beforeHash: null, afterHash: hash('a\n'), entries: null }] as const;
  held.begin({ ...request(root, []).run, planHash: 'a'.repeat(64), operations: [...operations] });
};

describe('recovery of a delete and of a step not started', () => {
  it.each([
    ['set-aside', 'gone\n'],
    ['written', null],
  ] as const)(
    'settles a delete killed after %s',
    async (boundary, left) => {
      const { root, state } = project({ '.claude/c.md': 'gone\n' });
      await crash(state, request(root, [remove('.claude/c.md', 'gone\n')]), boundary, 0);
      expect(apply(store(state), request(root, [])).findings).toEqual([recovered('.claude/c.md')]);
      expect([listing(root), text(join(root, '.claude/c.md'))]).toEqual([left === null ? [] : ['c.md'], left]);
      expect(run(state, 'r1')).toEqual({ status: 'interrupted', steps: ['settled'] });
    },
    20_000,
  );

  it('settles only the step that ran when a later one would leave the same file', async () => {
    const { root, state } = project();
    const plan = request(root, [create('.claude/a.md', 'a\n'), remove('.claude/a.md', 'a\n')]);
    await crash(state, plan, 'temp-written', 0);
    expect(apply(store(state), request(root, [])).findings).toEqual([recovered('.claude/a.md')]);
    expect([listing(root), run(state, 'r1')]).toEqual([[], { status: 'interrupted', steps: ['settled', 'pending'] }]);
  }, 20_000);

  it('settles a run whose temporary name is too long to exist, so the next apply runs', () => {
    const { root, state } = project();
    const held = store(state);
    begin(held, root, `.claude/${'n'.repeat(250)}.md`);
    nextApplyRuns(held, root, state);
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

const undone = (state: string, id: string): string | null => {
  const found = view(state).run(id);
  if (!found.ok || found.value === undefined) throw new Error(`no run ${id}`);
  return found.value.undoneBy;
};

// Releases a store before another process takes it.
const release = (held: RunStore): void => {
  opened.splice(opened.indexOf(held), 1);
  held.close();
};

// Undo of r1 refuses a folder link put at .claude/skills.
const refusesLinkedSkills = (held: RunStore, root: string): void => {
  symlinkSync(fresh(), join(root, '.claude/skills'), 'junction');
  expect(undo(held, { root, run: 'r1' }).refusal).toEqual({ code: 'plan.symlink', params: { path: '.claude/skills' } });
};

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
  });

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
    refusesLinkedSkills(held, root);
  });
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
    expect([run(state, 'u1'), undone(state, 'r1')]).toEqual([{ status: 'failed', steps: ['done', 'failed'] }, null]);
    expect(undo(held, { root, run: 'u1' }).run).toBe('u2');
    expect([text(join(root, '.claude/a.md')), text(join(root, '.claude/b.md'))]).toEqual(['theirs\n', 'new\n']);
  });

  it('waits for a step recovery left unsettled while a link is on its way', () => {
    const { root, state } = project();
    const held = store(state);
    begin(held, root, '.claude/skills/a.md');
    refusesLinkedSkills(held, root);
  });
});

// A step hook that throws at `boundary` of the operation at `position`, as a disk failing there.
const failAt =
  (boundary: Boundary, position: number) =>
  (at: Boundary, index: number): void => {
    if (at === boundary && index === position) throw new Error('disk gone');
  };

describe('undo of a replaced undo', () => {
  // Each undo before the last one runs; the last one would leave r1 counted as in effect, or not, against its file.
  it.each([
    [['r1', 'u1', 'r1'], 'old\n'],
    [['r1', 'u1', 'r1', 'u3'], 'new\n'],
  ])('refuses to undo u2 after the undos of %j: u3 replaced u1 as the undo of r1', (before, left) => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state, 'r1', 'u1', 'u2', 'u3', 'u4', 'u5');
    apply(held, request(root, [replace('.claude/b.md', 'old\n', 'new\n')]));
    for (const id of before) expect(undo(held, { root, run: id }).refusal).toBeNull();
    expect(undo(held, { root, run: 'u2' }).refusal).toEqual({
      code: 'run.already-undone',
      params: { run: 'r1', by: 'u3' },
    });
    expect(text(join(root, '.claude/b.md'))).toBe(left);
  });

  it('refuses to undo an interrupted undo once a newer undo of the run is recorded', () => {
    const { root, state } = project({ '.claude/b.md': 'old\n' });
    const held = store(state, 'r1', 'u1', 'u2', 'u3');
    apply(held, request(root, [replace('.claude/b.md', 'old\n', 'new\n')]));
    expect(() => undo(held, { root, run: 'r1' }, failAt('linked', 0))).toThrow('disk gone');
    expect(undo(held, { root, run: 'r1' }).run).toBe('u2');
    expect(undo(held, { root, run: 'u1' }).refusal).toEqual({
      code: 'run.already-undone',
      params: { run: 'r1', by: 'u2' },
    });
    expect(text(join(root, '.claude/b.md'))).toBe('old\n');
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
    const opening = openStore(state, clock);
    if (!opening.ok) throw new Error(opening.refusal.code);
    const held = opening.value;
    opened.push(held);
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
});

describe('recovery of an undo', () => {
  it.each(['temp-written', 'set-aside', 'linked', 'written'] as const)(
    'settles an undo killed after %s like any run, and its undo leaves the run result',
    async (boundary) => {
      const { root, state } = project({ '.claude/b.md': 'old\n' });
      const first = store(state);
      apply(first, request(root, [replace('.claude/b.md', 'old\n', 'new\n')]));
      release(first);
      await crash(state, { root, run: 'r1' }, boundary, 0);
      const result = undo(store(state, 'u2'), { root, run: 'u1' });
      expect([result.run, result.refusal, result.findings]).toEqual(['u2', null, [recovered('.claude/b.md', 'u1')]]);
      expect([run(state, 'u1'), undone(state, 'u1')]).toEqual([{ status: 'interrupted', steps: ['settled'] }, 'u2']);
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
