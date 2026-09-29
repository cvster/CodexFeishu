import { describe, expect, it, vi } from 'vitest';
import { createBoundChat, isSoloUserBotChat } from '../../../src/bot/group.js';

describe('solo user + bot group detection', () => {
  it('makes the first invited human the owner of an app-created group', async () => {
    const create = vi.fn(async () => ({ code: 0, data: { chat_id: 'oc_created' } }));
    const channel = { rawClient: { im: { v1: { chat: { create } } } } };

    await expect(createBoundChat({
      channel: channel as never,
      name: 'AA任务',
      inviteOpenIds: ['ou_owner', 'ou_admin'],
    })).resolves.toEqual({ chatId: 'oc_created', name: 'AA任务' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      params: { user_id_type: 'open_id' },
      data: expect.objectContaining({
        owner_id: 'ou_owner',
        user_id_list: ['ou_owner', 'ou_admin'],
      }),
    }));
  });

  it('allows no-mention handling only for exactly one user and this bot', async () => {
    const get = vi.fn(async () => ({ data: { user_count: '1', bot_count: '1' } }));
    const channel = { rawClient: { im: { v1: { chat: { get } } } } };

    await expect(isSoloUserBotChat(channel as never, 'oc_solo')).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith({ path: { chat_id: 'oc_solo' } });
  });

  it.each([
    ['2', '1'],
    ['1', '2'],
    ['0', '1'],
  ])('requires a mention for user_count=%s bot_count=%s', async (userCount, botCount) => {
    const channel = {
      rawClient: {
        im: { v1: { chat: { get: async () => ({ data: { user_count: userCount, bot_count: botCount } }) } } },
      },
    };

    await expect(isSoloUserBotChat(channel as never, 'oc_group')).resolves.toBe(false);
  });
});
