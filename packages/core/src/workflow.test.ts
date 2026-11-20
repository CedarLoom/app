import { expect, it } from 'vitest';
import { WorkflowName } from './workflow.ts';

it.each(['con', 'prn', 'com1', 'lpt9'])('refuses the Windows device name %s', (name) => {
  expect(WorkflowName.safeParse(name).success).toBe(false);
});
