import { describe, expect, it, vi } from 'vitest';
import { syncCodexThreadNameFromChat } from '../../../src/bot/thread-name.js';

describe('Codex thread naming from Feishu chats', () => {
  it('uses the latest group name and avoids duplicate updates', async () => {
    const getChatInfo = vi.fn(async () => ({ name: 'Codex任务4' }));
    const setThreadName = vi.fn(async () => {});
    const syncedNames = new Map<string, string>();
    const input = {
      channel: { getChatInfo } as never,
      agent: { setThreadName } as never,
      chatId: 'oc_group',
      threadId: 'thread-1',
      knownChats: [],
      syncedNames,
    };

    await syncCodexThreadNameFromChat(input);
    await syncCodexThreadNameFromChat(input);

    expect(setThreadName).toHaveBeenCalledTimes(1);
    expect(setThreadName).toHaveBeenCalledWith('thread-1', 'Codex任务4');
    expect(syncedNames.get('thread-1')).toBe('Codex任务4');
  });

  it('falls back to the cached chat name when live lookup fails', async () => {
    const setThreadName = vi.fn(async () => {});
    await syncCodexThreadNameFromChat({
      channel: { getChatInfo: vi.fn(async () => { throw new Error('offline'); }) } as never,
      agent: { setThreadName } as never,
      chatId: 'oc_group',
      threadId: 'thread-2',
      knownChats: [{ id: 'oc_group', name: '缓存群名' }],
      syncedNames: new Map(),
    });

    expect(setThreadName).toHaveBeenCalledWith('thread-2', '缓存群名');
  });
});
