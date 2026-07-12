import { describe, expect, it, vi } from 'vitest';
import { isSoloUserBotChat } from '../../../src/bot/group.js';

describe('solo user + bot group detection', () => {
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
