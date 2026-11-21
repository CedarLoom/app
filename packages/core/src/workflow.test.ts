import { expect, it } from 'vitest';
import { WorkflowName } from './workflow.ts';

it.each(['con', 'prn', 'com0', 'com1', 'lpt0', 'lpt9'])('refuses the Windows device name %s', (name) => {
  expect(WorkflowName.safeParse(name).success).toBe(false);
});

it('takes a name of 166 characters and refuses one of 167, whose aside would pass 255 bytes', () => {
  expect(WorkflowName.safeParse('a'.repeat(166)).success).toBe(true);
  expect(WorkflowName.safeParse('a'.repeat(167)).success).toBe(false);
});
