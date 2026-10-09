import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

interface ManagedEntry {
  cardId: string;
  sequence: number;
}

// Module-local because state is per-process. Lost on restart, which is fine —
// a new run of /account will mint a fresh card.
const byMessageId = new Map<string, ManagedEntry>();

export interface ManagedCardSendResult {
  messageId: string;
  cardId: string;
}

/**
 * Create a CardKit 2.0 card entity and send a message that references it.
 * Returns both ids; we keep them in a module-local map so future cardAction
 * events can update the card by its messageId.
 *
 * `recipientId` is routed by its id prefix (channel.send infers
 * `receive_id_type`): `oc_*` → chat, `ou_*` → direct message to that user
 * (Lark auto-resolves the p2p chat). If `replyTo` is provided, the card
 * threads under that message — only meaningful for chat sends.
 */
export async function sendManagedCard(
  channel: LarkChannel,
  recipientId: string,
  card: object,
  opts: { replyTo?: string; replyInThread?: boolean; isActive?: () => boolean } = {},
): Promise<ManagedCardSendResult> {
  const checkActive = () => {
    if (opts.isActive && !opts.isActive()) throw new Error('会话已归档或已重新绑定。');
  };
  checkActive();
  const sendOpts = opts.replyTo
    ? { replyTo: opts.replyTo, ...(opts.replyInThread ? { replyInThread: true } : {}) }
    : undefined;
  const { cardId } = await channel.createCard(card);
  checkActive();
  let messageId: string;
  try {
    ({ messageId } = await channel.send(recipientId, { cardId }, sendOpts));
  } catch (err) {
    if (!sendOpts || !isInvalidCardIdReply(err)) throw err;
    checkActive();
    log.warn('card', 'managed-reply-card-id-retry-as-message', {
      err: err instanceof Error ? err.message : String(err),
      replyTo: opts.replyTo,
      replyInThread: opts.replyInThread === true,
    });
    ({ messageId } = await channel.send(recipientId, { cardId }));
  }
  byMessageId.set(messageId, { cardId, sequence: 0 });
  return { messageId, cardId };
}

function isInvalidCardIdReply(err: unknown): boolean {
  return /card\s*id\s+is\s+invalid|cardid\s+is\s+invalid/i.test(
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * Update a managed card identified by the messageId of the message that
 * carries it. CardKit card-id sends use the per-card sequence required by the
 * card server.
 */
export async function updateManagedCard(
  channel: LarkChannel,
  messageId: string,
  card: object,
): Promise<void> {
  const entry = byMessageId.get(messageId);
  if (!entry) {
    throw new Error(`no managed card registered for message ${messageId}`);
  }
  entry.sequence += 1;
  try {
    await channel.updateCardById(entry.cardId, card, entry.sequence);
  } catch (err) {
    log.fail('card', err, {
      step: 'managed-update',
      cardId: entry.cardId,
      seq: entry.sequence,
    });
    throw err;
  }
}

/** True iff we have the card_id mapping for this messageId. */
export function isManaged(messageId: string): boolean {
  return byMessageId.has(messageId);
}

/** Drop the mapping; call after the card is recalled or the flow ends. */
export function forgetManagedCard(messageId: string): void {
  byMessageId.delete(messageId);
}
