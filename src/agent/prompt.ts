export type BridgePromptSource = 'im' | 'card' | 'comment';

export interface BridgePromptMention {
  openId?: string;
  name?: string;
  isBot?: boolean;
}

export interface BridgePromptContext {
  chatId: string;
  chatType: string;
  senderId: string;
  senderName?: string;
  /** Whether the sender is a human user or another bot ('app' sender). */
  senderType?: 'user' | 'bot';
  /** The bridge bot's own open_id — "this id is you" for self-identification. */
  botOpenId?: string;
  /** Accounts @-mentioned in the triggering message(s), deduped across the batch. */
  mentions?: BridgePromptMention[];
  threadId?: string;
  messageIds?: string[];
  source: BridgePromptSource;
}

export interface BridgePromptQuotedMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptInteractiveCard {
  messageId?: string;
  content: unknown;
}

/**
 * A prior message in the same Feishu topic, supplied as read-only context when
 * the bot is first pulled into a topic it hasn't been part of. Distinct from
 * `quotedMessages` (an explicit reply-quote): this is the topic's upstream
 * conversation the bot would otherwise be blind to.
 */
export interface BridgePromptTopicMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  senderType?: 'user' | 'bot';
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptComment {
  commentScopeId: string;
  isWholeDocument: boolean;
  docsLink?: string;
  question: string;
  quote?: string;
}

export interface BridgePromptAttachment {
  path: string;
  kind: string;
  hash?: string;
  size?: number;
  mime?: string;
  sourceMessageId?: string;
  requiredness?: 'required' | 'optional';
  decision?: 'accepted' | 'rejected' | 'skipped';
  rejectionReason?: string;
}

export interface BuildAgentPromptInput {
  context: BridgePromptContext;
  instructions?: string[];
  userInput: string;
  topicContext?: BridgePromptTopicMessage[];
  quotedMessages?: BridgePromptQuotedMessage[];
  interactiveCards?: BridgePromptInteractiveCard[];
  comment?: BridgePromptComment;
  attachments?: BridgePromptAttachment[];
}

export interface BuildCodexUserPromptInput {
  userInput: string;
  instructions?: string[];
  topicContext?: BridgePromptTopicMessage[];
  quotedMessages?: BridgePromptQuotedMessage[];
  interactiveCards?: BridgePromptInteractiveCard[];
  attachments?: BridgePromptAttachment[];
  mentions?: BridgePromptMention[];
}

/**
 * Keep the common Codex path genuinely plain: a normal Feishu text message is
 * byte-for-byte the userInput supplied here. Rich Feishu-only details are
 * reduced to one compact block only when the model cannot infer them from the
 * text or native image inputs.
 */
export function buildCodexUserPrompt(input: BuildCodexUserPromptInput): string {
  const context: Record<string, unknown> = {};
  if (input.instructions?.length) context.instructions = input.instructions;
  if (input.topicContext?.length) {
    context.topic = input.topicContext.map(compactConversationMessage);
  }
  if (input.quotedMessages?.length) {
    context.quotes = input.quotedMessages.map(compactConversationMessage);
  }
  if (input.interactiveCards?.length) {
    context.cards = input.interactiveCards.map((card) => card.content);
  }
  const attachments = input.attachments
    ?.filter((attachment) => !isNativeCodexImage(attachment))
    .map((attachment) => ({
      path: attachment.path,
      kind: attachment.kind,
      ...(attachment.mime ? { mime: attachment.mime } : {}),
      ...(attachment.decision ? { decision: attachment.decision } : {}),
      ...(attachment.rejectionReason ? { rejectionReason: attachment.rejectionReason } : {}),
    }));
  if (attachments?.length) context.attachments = attachments;
  if (input.mentions?.length) context.mentions = input.mentions;

  return Object.keys(context).length === 0
    ? input.userInput
    : `${promptSection('lark_context', context)}\n\n${input.userInput}`;
}

export function buildAgentPrompt(input: BuildAgentPromptInput): string {
  const sections = [
    promptSection('bridge_context', input.context),
    input.instructions && input.instructions.length > 0
      ? promptSection('bridge_instructions', input.instructions)
      : undefined,
    input.topicContext && input.topicContext.length > 0
      ? promptSection('topic_context', input.topicContext)
      : undefined,
    input.quotedMessages && input.quotedMessages.length > 0
      ? promptSection('quoted_messages', input.quotedMessages)
      : undefined,
    input.interactiveCards && input.interactiveCards.length > 0
      ? promptSection('interactive_cards', input.interactiveCards)
      : undefined,
    input.comment ? promptSection('comment_context', input.comment) : undefined,
    promptSection('user_input', {
      text: input.userInput,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    }),
  ];

  return sections.filter(Boolean).join('\n\n');
}

export function promptSection(tag: string, value: unknown): string {
  return `<${tag}>\n${safeJsonStringify(value)}\n</${tag}>`;
}

export function safeJsonStringify(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function compactConversationMessage(
  message: BridgePromptQuotedMessage | BridgePromptTopicMessage,
): Record<string, unknown> {
  return {
    ...(message.senderName ? { sender: message.senderName } : {}),
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    type: message.rawContentType,
    content: message.content,
  };
}

function isNativeCodexImage(attachment: BridgePromptAttachment): boolean {
  return attachment.kind === 'image' && attachment.decision !== 'rejected';
}
