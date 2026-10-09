import { describe, expect, it, vi } from 'vitest';
import { sendManagedCard, updateManagedCard } from '../../../src/card/managed.js';

describe('managed card sending', () => {
  it('does not send a minted card if its conversation was archived during creation', async () => {
    let active = true;
    const channel = { createCard: vi.fn(async () => { active = false; return { cardId: 'unused' }; }), send: vi.fn() };
    await expect(sendManagedCard(channel as never, 'oc_chat', {}, { isActive: () => active })).rejects.toThrow('已归档');
    expect(channel.send).not.toHaveBeenCalled();
  });
  it('surfaces CardKit creation errors instead of sending a raw card', async () => {
    const channel = {
      createCard: vi.fn(async () => {
        throw new Error('missing cardkit:card:write');
      }),
      send: vi.fn(async () => ({ messageId: 'om_raw_create' })),
    };

    const card = { schema: '2.0', body: { elements: [] } };
    await expect(sendManagedCard(channel as never, 'oc_chat', card)).rejects.toThrow(
      'missing cardkit:card:write',
    );

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('retries an invalid card-id reply as a new CardKit message', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_1' })),
      send: vi.fn()
        .mockRejectedValueOnce(new Error('ErrCode: 11310; ErrMsg: cardid is invalid'))
        .mockResolvedValueOnce({ messageId: 'om_new_message' }),
    };

    const result = await sendManagedCard(
      channel as never,
      'oc_chat',
      { type: 'template', data: { template_id: 'tpl' } },
      { replyTo: 'om_parent', replyInThread: true },
    );

    expect(result).toEqual({ messageId: 'om_new_message', cardId: 'card_1' });
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.send).toHaveBeenNthCalledWith(
      1,
      'oc_chat',
      { cardId: 'card_1' },
      { replyTo: 'om_parent', replyInThread: true },
    );
    expect(channel.send).toHaveBeenNthCalledWith(2, 'oc_chat', { cardId: 'card_1' });
  });

  it('surfaces other card-id send errors without a compatibility fallback', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_2' })),
      send: vi.fn(async () => {
        throw new Error('network timeout');
      }),
    };

    await expect(
      sendManagedCard(channel as never, 'oc_chat', { schema: '2.0' }, { replyTo: 'om_parent' }),
    ).rejects.toThrow('network timeout');
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('updates card-id managed messages by card id', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_normal' })),
      send: vi.fn(async () => ({ messageId: 'om_normal' })),
      updateCardById: vi.fn(async () => {}),
      updateCard: vi.fn(async () => {}),
    };

    await sendManagedCard(channel as never, 'oc_chat', { body: 'form' });
    await updateManagedCard(channel as never, 'om_normal', { body: 'cancelled' });

    expect(channel.updateCardById).toHaveBeenCalledWith('card_normal', { body: 'cancelled' }, 1);
    expect(channel.updateCard).not.toHaveBeenCalled();
  });
});
