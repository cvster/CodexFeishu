import type { LarkChannel } from '@larksuite/channel';

export interface CreateBoundChatOptions {
  channel: LarkChannel;
  name: string;
  inviteOpenId?: string;
  inviteOpenIds?: readonly string[];
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
  const { channel, name, description } = opts;
  const inviteUserIds = [...new Set([
    ...(opts.inviteOpenIds ?? []),
    ...(opts.inviteOpenId ? [opts.inviteOpenId] : []),
  ].filter(Boolean))];
  if (inviteUserIds.length === 0) throw new Error('at least one invite open_id is required');
  const { chatId } = await channel.createChat({
    name,
    description,
    inviteUserIds,
    userIdType: 'open_id',
  });
  return { chatId, name };
}

/**
 * Permanently dissolve a group created by this app. Feishu only permits an
 * app-identity call when the bot is the owner, or when the bot created the
 * group and has the corresponding chat-management permission.
 */
export async function dissolveChat(channel: LarkChannel, chatId: string): Promise<void> {
  const response = await channel.rawClient.im.v1.chat.delete({ path: { chat_id: chatId } });
  if (response.code && response.code !== 0) {
    throw new Error(`Feishu rejected chat deletion (${response.code}): ${response.msg ?? 'unknown error'}`);
  }
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
