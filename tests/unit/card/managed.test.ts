import { describe, expect, it, vi } from 'vitest';
import { sendManagedCard, updateManagedCard } from '../../../src/card/managed.js';

describe('managed card sending', () => {
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

  it('surfaces card-id message errors instead of sending a raw card', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_1' })),
      send: vi.fn(async () => {
        throw new Error('cardid is invalid');
      }),
    };

    await expect(
      sendManagedCard(
        channel as never,
        'oc_chat',
        { type: 'template', data: { template_id: 'tpl' } },
        { replyTo: 'om_parent', replyInThread: true },
      ),
    ).rejects.toThrow('cardid is invalid');

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith(
      'oc_chat',
      { cardId: 'card_1' },
      { replyTo: 'om_parent', replyInThread: true },
    );
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
