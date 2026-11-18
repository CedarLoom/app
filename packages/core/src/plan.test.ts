import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type PlanOperation, planHash } from './plan.ts';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('planHash', () => {
  it('hashes each operation by kind, path and hashes, leaving the texts out', () => {
    const operations: PlanOperation[] = [
      { kind: 'create', path: '.claude/a.md', beforeHash: null, afterHash: 'b'.repeat(64), before: null, after: 'new' },
      { kind: 'delete', path: '.claude/b.md', beforeHash: 'a'.repeat(64), afterHash: null, before: 'old', after: null },
    ];
    expect(planHash(operations, sha256)).toBe('e77d5ea7b49cd68aa978c88f0a6ffd0af3b739ac24c45e35be543bfc1e1675be');
  });
});
