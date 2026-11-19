import { expect, it } from 'vitest';
import { messageText } from './message-text.ts';

it('renders a select argument by the branch its value names, null included, else by other', () => {
  const catalog = { m: [['path', 'select', { null: ['none'], other: ['in ', ['path']] }], '.'] };
  expect([null, '/a'].map((path) => messageText(catalog, 'm', { path }))).toEqual(['none.', 'in /a.']);
});
