import type { LarkChannel } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import { log } from '../core/logger';
import type { KnownChat } from './lark-info';

export interface SyncCodexThreadNameInput {
  channel: LarkChannel;
  agent: AgentAdapter;
  chatId: string;
  threadId: string;
  knownChats: KnownChat[];
  syncedNames: Map<string, string>;
}

export async function syncCodexThreadNameFromChat(input: SyncCodexThreadNameInput): Promise<void> {
  if (!input.agent.setThreadName) return;
  let name: string | undefined;
  try {
    name = (await input.channel.getChatInfo(input.chatId)).name?.trim();
  } catch (err) {
    log.warn('session', 'chat-name-fetch-failed', {
      chatId: input.chatId,
      err: err instanceof Error ? err.message : String(err),
    });
    name = input.knownChats.find((chat) => chat.id === input.chatId)?.name.trim();
  }
  if (!name || input.syncedNames.get(input.threadId) === name) return;
  await input.agent.setThreadName(input.threadId, name);
  input.syncedNames.set(input.threadId, name);
  log.info('session', 'thread-name-synced', { threadId: input.threadId, name });
}
