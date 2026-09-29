export const CODEX_BRIDGE_CLIENT_ID_PREFIX = 'lark-channel-bridge:';

interface QueuedTurnClaim {
  threadId: string;
  prompt: string;
  knownTurnIds: ReadonlySet<string>;
}

const queuedTurnClaims = new Map<string, QueuedTurnClaim>();
const claimedTurnIds = new Set<string>();
const claimedTurnOrder: string[] = [];
const MAX_CLAIMED_TURNS = 1_000;

/** Stable per-run marker persisted by Codex on the userMessage item. */
export function codexBridgeClientMessageId(runId: string): string {
  return `${CODEX_BRIDGE_CLIENT_ID_PREFIX}${runId}`;
}

export function isCodexBridgeClientMessageId(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(CODEX_BRIDGE_CLIENT_ID_PREFIX);
}

/**
 * Native `codex queue` currently generates its own client id, so it cannot
 * persist our lark-channel-bridge marker on the userMessage item. Register the
 * exact turn we are about to enqueue so the desktop-turn mirror does not
 * mistake the bridge-owned turn for Desktop input and create a duplicate card.
 */
export function registerCodexQueuedTurnClaim(
  claimId: string,
  threadId: string,
  prompt: string,
  knownTurnIds: Iterable<string>,
): void {
  queuedTurnClaims.set(claimId, {
    threadId,
    prompt,
    knownTurnIds: new Set(knownTurnIds),
  });
}

export function bindCodexQueuedTurnClaim(claimId: string, turnId: string): void {
  const claim = queuedTurnClaims.get(claimId);
  if (!claim) return;
  rememberClaimedTurn(claim.threadId, turnId);
  queuedTurnClaims.delete(claimId);
}

export function releaseCodexQueuedTurnClaim(claimId: string): void {
  queuedTurnClaims.delete(claimId);
}

export function isClaimedCodexBridgeTurn(
  threadId: string,
  turnId: string,
  prompt: string,
): boolean {
  const key = claimedTurnKey(threadId, turnId);
  if (claimedTurnIds.has(key)) return true;

  for (const [claimId, claim] of queuedTurnClaims) {
    if (
      claim.threadId !== threadId ||
      claim.knownTurnIds.has(turnId) ||
      claim.prompt !== prompt
    ) {
      continue;
    }
    rememberClaimedTurn(threadId, turnId);
    queuedTurnClaims.delete(claimId);
    return true;
  }
  return false;
}

function rememberClaimedTurn(threadId: string, turnId: string): void {
  const key = claimedTurnKey(threadId, turnId);
  if (claimedTurnIds.has(key)) return;
  claimedTurnIds.add(key);
  claimedTurnOrder.push(key);
  while (claimedTurnOrder.length > MAX_CLAIMED_TURNS) {
    const oldest = claimedTurnOrder.shift();
    if (oldest) claimedTurnIds.delete(oldest);
  }
}

function claimedTurnKey(threadId: string, turnId: string): string {
  return `${threadId}\0${turnId}`;
}
