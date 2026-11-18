import { describe, expect, it } from 'vitest';
import { Run, RunSummary, SettingsEntry } from './run.ts';

const summary = {
  id: 'r1',
  kind: 'apply',
  action: 'workflow.new',
  subject: 'demo',
  status: 'done',
  startedAt: '2026-11-18T22:17:39.123Z',
  endedAt: '2026-11-18T22:17:40.000Z',
  undoes: null,
  undoneBy: null,
};

describe('RunSummary', () => {
  it('accepts a timestamp as Date.toISOString writes it', () => {
    expect(RunSummary.safeParse(summary).success).toBe(true);
  });

  it.each(['2026-11-18T22:17:39Z', '2026-11-18T22:17:39.5Z', '2026-11-18T22:17:39.123456789Z'])(
    'refuses the timestamp %s',
    (startedAt) => {
      expect(RunSummary.safeParse({ ...summary, startedAt }).success).toBe(false);
    },
  );

  it('accepts an undo that names the run it undoes', () => {
    expect(RunSummary.safeParse({ ...summary, id: 'r2', kind: 'undo', action: 'undo', undoes: 'r1' }).success).toBe(
      true,
    );
  });

  it.each([
    ['an apply with the undo action', { action: 'undo' }],
    ['an undo with no undoes', { kind: 'undo', action: 'undo' }],
    ['an apply that sets undoes', { undoes: 'r0' }],
    ['an undo with another action', { kind: 'undo', undoes: 'r0' }],
    ['a running run with an end', { status: 'running' }],
    ['a run that undoes itself', { kind: 'undo', action: 'undo', undoes: 'r1' }],
    ['a run undone by itself', { undoneBy: 'r1' }],
  ])('refuses %s', (_name, change) => {
    expect(RunSummary.safeParse({ ...summary, ...change }).success).toBe(false);
  });
});

describe('Run', () => {
  const run = { ...summary, planHash: 'a'.repeat(64), operations: [], generatedFrom: [] };

  it('applies the same rules as the summary', () => {
    expect(Run.safeParse(run).success).toBe(true);
    expect(Run.safeParse({ ...run, action: 'undo' }).success).toBe(false);
    expect(Run.safeParse({ ...run, startedAt: '2026-11-18T22:17:39Z' }).success).toBe(false);
  });
});

describe('SettingsEntry', () => {
  it('keeps a replaced JSON null apart from no earlier value', () => {
    expect(SettingsEntry.parse({ pointer: '/a', value: 1, before: null })).toEqual({
      pointer: '/a',
      value: 1,
      before: null,
    });
    expect(Object.keys(SettingsEntry.parse({ pointer: '/a', value: 1 }))).toEqual(['pointer', 'value']);
  });

  it('refuses an explicit undefined before', () => {
    expect(SettingsEntry.safeParse({ pointer: '/a', value: 1, before: undefined }).success).toBe(false);
  });

  it('refuses a "__proto__" member instead of dropping it', () => {
    const value: unknown = JSON.parse('{"__proto__":{"x":1},"k":1}');
    expect(SettingsEntry.safeParse({ pointer: '/a', value }).success).toBe(false);
    expect(SettingsEntry.safeParse({ pointer: '/a', value: [value] }).success).toBe(false);
    expect(SettingsEntry.safeParse({ pointer: '/a', value: 1, before: value }).success).toBe(false);
  });
});
