// Live cards must refresh through their existing SDK controller, whose update
// queue serializes the refresh with normal streamed output.
const liveCards = new Map<string, { scope: string; refresh(): Promise<void> }>();

export function registerLiveRunCardRefresh(
  messageId: string,
  scope: string,
  refresh: () => Promise<void>,
): () => void {
  const entry = { scope, refresh };
  liveCards.set(messageId, entry);
  return () => {
    if (liveCards.get(messageId) === entry) liveCards.delete(messageId);
  };
}

export async function refreshLiveRunCard(messageId: string, scope: string): Promise<boolean> {
  const entry = liveCards.get(messageId);
  if (!entry || entry.scope !== scope) return false;
  await entry.refresh();
  return true;
}
