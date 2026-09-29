import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

export interface KnownChat {
  id: string;
  name: string;
}

export type KnownChatsFetchResult =
  | { ok: true; chats: KnownChat[] }
  | { ok: false; chats: [] };

export async function fetchKnownChatsResult(channel: LarkChannel): Promise<KnownChatsFetchResult> {
  try {
    const summaries = await channel.listChats({ pageSize: 100, maxPages: 5 });
    const chats: KnownChat[] = summaries.map((c) => ({
      id: c.id,
      name: c.name || '(无名)',
    }));
    log.info('lark-info', 'chats-fetched', { count: chats.length });
    return { ok: true, chats };
  } catch (err) {
    log.warn('lark-info', 'chats-fetch-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, chats: [] };
  }
}

export async function fetchKnownChats(channel: LarkChannel): Promise<KnownChat[]> {
  return (await fetchKnownChatsResult(channel)).chats;
}
