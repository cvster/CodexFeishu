import { describe, expect, it } from 'vitest';
import { defaultChatName, isDefaultChatName } from '../../../src/bot/group.js';

describe('group chat helpers', () => {
  it('starts default group names at Codex任务1', () => {
    expect(defaultChatName()).toBe('Codex任务1');
  });

  it('uses the first available numeric suffix', () => {
    expect(defaultChatName(['Codex任务1', 'Codex任务2', '其他群'])).toBe('Codex任务3');
    expect(defaultChatName(['Codex任务1', 'Codex任务3'])).toBe('Codex任务2');
  });

  it('recognizes generated default names', () => {
    expect(isDefaultChatName('Codex任务12')).toBe(true);
    expect(isDefaultChatName('Codex任务')).toBe(false);
    expect(isDefaultChatName('Codez任务1')).toBe(false);
  });
});
