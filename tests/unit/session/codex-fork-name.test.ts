import { describe, expect, it } from 'vitest';
import { nextCodexForkName } from '../../../src/session/codex-fork-name';

describe('Codex fork names', () => {
  it('adds a numeric suffix and skips existing names', () => {
    expect(nextCodexForkName('AA-test', ['AA-test', 'AA-test (1)', 'AA-test (2)']))
      .toBe('AA-test (3)');
  });
  it('keeps a single suffix when forking a fork', () => {
    expect(nextCodexForkName('project (2)', ['project (1)', 'project (2)']))
      .toBe('project (3)');
  });
});
