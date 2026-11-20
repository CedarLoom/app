import { describe, expect, it } from 'vitest';
import { type SwitchRecord, switchedOff, switchedOn } from './settings-switch.ts';

// The merge, undo, owner-entry and plugin cases run end to end in use-cases/src/workflow-switch.test.ts.
const path = '.claude/settings.json';
const PLUGIN = 'cl-workflow@cedarloom';
const POINTER = '/enabledPlugins/cl-workflow@cedarloom';
const RULES = { rules: ['Skill(dev)', 'Workflow(dev-run)'] };
const deny = (value: string) => ({ pointer: '/permissions/deny', value });
const off = (...entries: SwitchRecord['entries']): SwitchRecord => ({ action: 'workflow.off', entries });
const on = (...entries: SwitchRecord['entries']): SwitchRecord => ({ action: 'workflow.on', entries });
const ownerEntry = (key: string) => ({
  code: 'settings.owner-entry',
  severity: 'warning',
  params: { path, key, kept: true },
});
const OWNED = [off(deny('Skill(dev)'), deny('Workflow(dev-run)'))];
const OFF = off({ pointer: POINTER, value: false });
const entry = (value: unknown) => `{"enabledPlugins": {"other@market": true, "${PLUGIN}": ${JSON.stringify(value)}}}`;

describe('switchedOff', () => {
  it('makes the permissions and deny members that are missing', () => {
    expect(switchedOff({ text: '{\n  "model": "opus"\n}\n', path }, [], { rules: ['Skill(dev)'] })?.text).toBe(
      '{\n  "model": "opus",\n  "permissions": {"deny":["Skill(dev)"]}\n}\n',
    );
    expect(switchedOff({ text: '{"permissions": {}}', path }, [], { rules: ['Skill(dev)'] })?.text).toBe(
      '{"permissions": {"deny": ["Skill(dev)"]}}',
    );
  });

  it('leaves a rule it owns at any position, and reports one a newer workflow.on gave up', () => {
    const text = '{"permissions": {"deny": ["Workflow(dev-run)", "Skill(dev)"]}}';
    expect(switchedOff({ text, path }, OWNED, RULES)).toEqual({ text: null, entries: [], skipped: [] });
    expect(switchedOff({ text, path }, [on(deny('Skill(dev)'), deny('Workflow(dev-run)')), ...OWNED], RULES)).toEqual({
      text: null,
      entries: [],
      skipped: [ownerEntry('Skill(dev)'), ownerEntry('Workflow(dev-run)')],
    });
  });
});

describe('switchedOn', () => {
  it('removes the last occurrence and reports the copy that stays', () => {
    const text = '{"permissions": {"deny": [\n  "Skill(dev)",\n  "Read(.env)",\n  "Skill(dev)"\n]}}';
    expect(switchedOn({ text, path }, OWNED, { rules: ['Skill(dev)'] })).toEqual({
      text: '{"permissions": {"deny": [\n  "Skill(dev)",\n  "Read(.env)"\n]}}',
      entries: [deny('Skill(dev)')],
      skipped: [ownerEntry('Skill(dev)')],
    });
  });

  it('reports a recorded rule the owner removed and removes the rest', () => {
    const text = '{"permissions": {"deny": ["Workflow(dev-run)"]}}';
    expect(switchedOn({ text, path }, OWNED, RULES)).toEqual({
      text: '{"permissions": {"deny": []}}',
      entries: [deny('Workflow(dev-run)')],
      skipped: [ownerEntry('Skill(dev)')],
    });
  });

  it('reports a plugin false a newer workflow.on gave up, and its own entry the owner changed or removed', () => {
    for (const [text, records] of [
      [entry(false), [on({ pointer: POINTER, value: false }), OFF]],
      [entry(true), [OFF]],
      ['{}', [OFF]],
    ] as const) {
      expect(switchedOn({ text, path }, records, { plugin: PLUGIN })).toEqual({
        text: null,
        entries: [],
        skipped: [ownerEntry(POINTER)],
      });
    }
  });

  it('changes nothing for an owner true', () => {
    expect(switchedOn({ text: entry(true), path }, [], { plugin: PLUGIN })).toEqual({
      text: null,
      entries: [],
      skipped: [],
    });
  });
});

describe('a settings file it does not change', () => {
  it.each([
    ['a value that is not an object', '[]'],
    ['permissions that is not an object', '{"permissions": ["Skill(dev)"]}'],
    ['enabledPlugins that is not an object', '{"enabledPlugins": true}'],
  ])('refuses %s', (_, text) => {
    expect(switchedOff({ text, path }, [], RULES)).toBeUndefined();
    expect(switchedOn({ text, path }, OWNED, RULES)).toBeUndefined();
  });

  it('refuses an edit that would not read back as the change, such as under a duplicate key', () => {
    const text = `{"enabledPlugins": {"${PLUGIN}": false, "${PLUGIN}": false}}`;
    expect(switchedOn({ text, path }, [OFF], { plugin: PLUGIN })).toBeUndefined();
  });
});
