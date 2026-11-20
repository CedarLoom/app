import { expect, it } from 'vitest';
import type { JsonValue } from './canonical-json.ts';
import { type Edit, edited } from './edit.ts';

const BEFORE: JsonValue = {
  stages: [
    { id: 'plan', phases: [{ id: 'a' }, { id: 'b' }] },
    { id: 'build', phases: [{ id: 'c', model: 'opus' }] },
  ],
};

const APPLIED: [string, Edit, JsonValue][] = [
  [
    'add at an index',
    { operation: 'add', pointer: '/stages/0/phases/1', value: { id: 'x' } },
    {
      stages: [
        { id: 'plan', phases: [{ id: 'a' }, { id: 'x' }, { id: 'b' }] },
        { id: 'build', phases: [{ id: 'c', model: 'opus' }] },
      ],
    },
  ],
  [
    'add with -',
    { operation: 'add', pointer: '/stages/-', value: { id: 'ship', phases: [] } },
    {
      stages: [
        { id: 'plan', phases: [{ id: 'a' }, { id: 'b' }] },
        { id: 'build', phases: [{ id: 'c', model: 'opus' }] },
        { id: 'ship', phases: [] },
      ],
    },
  ],
  [
    'move within a stage',
    { operation: 'move', from: '/stages/0/phases/0', to: '/stages/0/phases/1' },
    {
      stages: [
        { id: 'plan', phases: [{ id: 'b' }, { id: 'a' }] },
        { id: 'build', phases: [{ id: 'c', model: 'opus' }] },
      ],
    },
  ],
  [
    'move between stages',
    { operation: 'move', from: '/stages/0/phases/1', to: '/stages/1/phases/0' },
    {
      stages: [
        { id: 'plan', phases: [{ id: 'a' }] },
        { id: 'build', phases: [{ id: 'b' }, { id: 'c', model: 'opus' }] },
      ],
    },
  ],
  [
    'move a stage',
    { operation: 'move', from: '/stages/1', to: '/stages/0' },
    {
      stages: [
        { id: 'build', phases: [{ id: 'c', model: 'opus' }] },
        { id: 'plan', phases: [{ id: 'a' }, { id: 'b' }] },
      ],
    },
  ],
  [
    'remove',
    { operation: 'remove', pointer: '/stages/0/phases/0' },
    {
      stages: [
        { id: 'plan', phases: [{ id: 'b' }] },
        { id: 'build', phases: [{ id: 'c', model: 'opus' }] },
      ],
    },
  ],
  [
    'set',
    { operation: 'set', pointer: '/stages/0/phases/1/model', value: 'fable' },
    {
      stages: [
        { id: 'plan', phases: [{ id: 'a' }, { id: 'b', model: 'fable' }] },
        { id: 'build', phases: [{ id: 'c', model: 'opus' }] },
      ],
    },
  ],
  [
    'set a member whose name holds / and ~',
    { operation: 'set', pointer: '/stages/0/a~1b~01', value: 1 },
    {
      stages: [
        { id: 'plan', phases: [{ id: 'a' }, { id: 'b' }], 'a/b~1': 1 },
        { id: 'build', phases: [{ id: 'c', model: 'opus' }] },
      ],
    },
  ],
  [
    'unset',
    { operation: 'unset', pointer: '/stages/1/phases/0/model' },
    {
      stages: [
        { id: 'plan', phases: [{ id: 'a' }, { id: 'b' }] },
        { id: 'build', phases: [{ id: 'c' }] },
      ],
    },
  ],
];

const REFUSED: [Edit, string][] = [
  [{ operation: 'add', pointer: '/stages/0/phases/3', value: {} }, '/stages/0/phases/3'],
  [{ operation: 'add', pointer: '/stages/0/id', value: {} }, '/stages/0/id'],
  [{ operation: 'add', pointer: 'stages/0', value: {} }, 'stages/0'],
  [{ operation: 'add', pointer: '/stages/01', value: {} }, '/stages/01'],
  [{ operation: 'remove', pointer: '/stages/-' }, '/stages/-'],
  [{ operation: 'remove', pointer: '/stages/2' }, '/stages/2'],
  [{ operation: 'move', from: '/stages/5', to: '/stages/0' }, '/stages/5'],
  [{ operation: 'move', from: '/stages/0/phases/0', to: '/stages/0/phases/0' }, '/stages/0/phases/0'],
  [{ operation: 'move', from: '/stages/0/phases/1', to: '/stages/0/phases/-' }, '/stages/0/phases/-'],
  [{ operation: 'move', from: '/stages/0/phases/0', to: '/stages/0/phases/2' }, '/stages/0/phases/2'],
  [{ operation: 'move', from: '/stages/0', to: '/stages/1/phases/0' }, '/stages/1/phases/0'],
  [{ operation: 'set', pointer: '', value: {} }, ''],
  [{ operation: 'set', pointer: '/stages/9/id', value: 'x' }, '/stages/9/id'],
  [{ operation: 'set', pointer: '/stages/0/phases/2', value: {} }, '/stages/0/phases/2'],
  [{ operation: 'set', pointer: '/stages/0/id/x', value: 1 }, '/stages/0/id/x'],
  [{ operation: 'set', pointer: '/__proto__', value: {} }, '/__proto__'],
  [{ operation: 'set', pointer: '/__proto__/x', value: 1 }, '/__proto__/x'],
  [{ operation: 'set', pointer: '/stages/0/__proto__/y', value: 1 }, '/stages/0/__proto__/y'],
  [{ operation: 'set', pointer: '/a~2', value: 1 }, '/a~2'],
  [{ operation: 'unset', pointer: '/description' }, '/description'],
  [{ operation: 'unset', pointer: '/stages/0' }, '/stages/0'],
];

it.each(APPLIED)('edited applies %s', (_, edit, after) => {
  expect(edited(BEFORE, edit)).toEqual({ definition: after });
});

it('leaves the definition it is given as it was', () => {
  const before = { stages: [{ phases: [] }] };
  edited(before, { operation: 'remove', pointer: '/stages/0' });
  expect(before).toEqual({ stages: [{ phases: [] }] });
});

it.each(REFUSED)('refuses %o with edit.target-invalid naming %s', (edit, pointer) => {
  expect(edited(BEFORE, edit)).toEqual({
    refusal: { code: 'edit.target-invalid', params: { pointer, operation: edit.operation } },
  });
});
