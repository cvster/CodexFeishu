import { describe, expect, it } from 'vitest';
import { defaultChatName, describeChatDeletionError, isDefaultChatName } from '../../../src/bot/group.js';

describe('group chat helpers', () => {
  it('explains the missing creator-management permission for a 232017 failure', () => {
    const message = describeChatDeletionError({ response: { data: { code: 232017, msg: 'no permission' } } });
    expect(message).toContain('im:chat:operate_as_owner');
    expect(message).toContain('发布新版本');
    expect(message).toContain('群主手动解散');
  });

  it('retains useful non-permission failure details', () => {
    expect(describeChatDeletionError(new Error('timeout'))).toBe('timeout');
    expect(describeChatDeletionError({ response: { data: { code: 232011, msg: 'Bot is not in chat' } } }))
      .toBe('Bot is not in chat（232011）');
  });

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
