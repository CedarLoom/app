import { compileMessageOrThrow } from '@lingui/message-utils/compileMessage';
import { expect, it } from 'vitest';
import { messageText } from './message-text.ts';

it('renders a select argument by the branch its value names, null included, else by other', () => {
  const catalog = { m: [['path', 'select', { null: ['none'], other: ['in ', ['path']] }], '.'] };
  expect([null, '/a'].map((path) => messageText(catalog, 'm', { path }))).toEqual(['none.', 'in /a.']);
});

it('renders a plural argument by its exact branch, else its English plural category, with # as the number', () => {
  const catalog = { m: compileMessageOrThrow('{count, plural, =0 {none} one {# problem} other {# problems}}') };
  expect([0, 1, 3].map((count) => messageText(catalog, 'm', { count }))).toEqual(['none', '1 problem', '3 problems']);
});
