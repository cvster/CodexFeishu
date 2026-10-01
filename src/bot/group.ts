import type { LarkChannel } from '@larksuite/channel';

export interface CreateBoundChatOptions {
  channel: LarkChannel;
  name: string;
  inviteOpenId?: string;
  inviteOpenIds?: readonly string[];
  /** Human owner of the group. Defaults to the first invited user. */
  ownerOpenId?: string;
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
    ...(opts.ownerOpenId ? [opts.ownerOpenId] : []),
    ...(opts.inviteOpenIds ?? []),
    ...(opts.inviteOpenId ? [opts.inviteOpenId] : []),
  ].filter(Boolean))];
  if (inviteUserIds.length === 0) throw new Error('at least one invite open_id is required');
  const ownerOpenId = opts.ownerOpenId ?? inviteUserIds[0]!;
  const response = await channel.rawClient.im.v1.chat.create({
    params: { user_id_type: 'open_id' },
    data: {
      name,
      description,
      chat_mode: 'group',
      chat_type: 'private',
      owner_id: ownerOpenId,
      user_id_list: inviteUserIds,
    },
  });
  const chatId = response.data?.chat_id;
  if (!chatId) throw new Error(`Feishu returned no chat_id (${response.code ?? 'unknown'}): ${response.msg ?? 'unknown error'}`);
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

/** Explain management-policy failures without exposing SDK transport details. */
export function describeChatDeletionError(error: unknown): string {
  const failure = error as { code?: unknown; msg?: unknown; response?: { data?: { code?: unknown; msg?: unknown } } } | null;
  const code = Number(failure?.response?.data?.code ?? failure?.code);
  if (code === 232017) {
    return '机器人没有解散此群的权限（232017）。如果此群由当前机器人创建，请在该应用的权限管理中开通“更新应用所创建群的群信息”（im:chat:operate_as_owner）并发布新版本；如果由旧机器人或其他人创建，请由群主手动解散。';
  }
  const message = failure?.response?.data?.msg ?? failure?.msg;
  if (typeof message === 'string' && Number.isFinite(code) && code !== 0) return `${message}（${code}）`;
  return error instanceof Error ? error.message : String(error);
}

/** Rename a group that remains bound while its Codex session advances. */
export async function renameChat(channel: LarkChannel, chatId: string, name: string): Promise<void> {
  const response = await channel.rawClient.im.v1.chat.update({
    path: { chat_id: chatId },
    data: { name },
  });
  if (response.code && response.code !== 0) {
    throw new Error(`Feishu rejected chat rename (${response.code}): ${response.msg ?? 'unknown error'}`);
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
