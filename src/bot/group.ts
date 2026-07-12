import type { LarkChannel } from '@larksuite/channel';

export interface CreateBoundChatOptions {
  channel: LarkChannel;
  name: string;
  inviteOpenId: string;
  description?: string;
}

export interface CreatedChat {
  chatId: string;
  name: string;
}

/**
 * Feishu reports human users and bots separately in chat info. A successful
 * lookup also proves this bot is currently in the chat.
 */
export async function isSoloUserBotChat(channel: LarkChannel, chatId: string): Promise<boolean> {
  const response = await channel.rawClient.im.v1.chat.get({ path: { chat_id: chatId } });
  const userCount = Number(response.data?.user_count);
  const botCount = Number(response.data?.bot_count);
  return userCount === 1 && botCount === 1;
}

/**
 * Create a private group chat with the bot (as creator) and one user. Returns
 * the new chat_id. Requires `im:chat` scope on the bot.
 */
export async function createBoundChat(opts: CreateBoundChatOptions): Promise<CreatedChat> {
  const { channel, name, inviteOpenId, description } = opts;
  const { chatId } = await channel.createChat({
    name,
    description,
    inviteUserIds: [inviteOpenId],
    userIdType: 'open_id',
  });
  return { chatId, name };
}

const DEFAULT_CHAT_PREFIX = 'Codex任务';

export function defaultChatName(existingNames: Iterable<string> = []): string {
  const used = new Set(Array.from(existingNames, (name) => name.trim()));
  let sequence = 1;
  while (used.has(`${DEFAULT_CHAT_PREFIX}${sequence}`)) sequence += 1;
  return `${DEFAULT_CHAT_PREFIX}${sequence}`;
}

export function isDefaultChatName(name: string): boolean {
  return /^Codex任务\d+$/.test(name.trim());
}
