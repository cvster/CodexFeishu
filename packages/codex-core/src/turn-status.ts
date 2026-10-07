import type { CodexThreadSnapshot, CodexThreadTurn } from './thread-client';

export const PROVISIONAL_INTERRUPTED_WINDOW_MS = 10 * 60_000;

export function isInterruptedTurnStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === 'interrupted' || normalized === 'cancelled' || normalized === 'canceled';
}

/**
 * A read-only app-server can briefly expose the Desktop-owned tail turn as
 * interrupted while the writer is still starting or persisting it. Such a
 * turn has no completion timestamp and the thread was updated recently. Keep
 * observing it instead of publishing a false terminal state.
 */
export function isProvisionalInterruptedTurn(
  snapshot: CodexThreadSnapshot,
  turn: CodexThreadTurn,
  nowMs = Date.now(),
): boolean {
  if (turn.id !== snapshot.turns.at(-1)?.id) return false;
  if (!isInterruptedTurnStatus(turn.status)) return false;
  // app-server has returned both `null` and an omitted `completedAt` while a
  // Desktop-owned turn is still being persisted. Treat both shapes as an
  // unconfirmed terminal state. A concrete timestamp is the only evidence
  // that the interruption has been committed.
  if (turn.completedAtMs !== null && turn.completedAtMs !== undefined) return false;
  if (snapshot.updatedAtMs === undefined) return false;
  return nowMs - snapshot.updatedAtMs <= PROVISIONAL_INTERRUPTED_WINDOW_MS;
}

/** Shared correction for an observer's projected interruption, not a writer cancellation. */
export async function reconcileCodexThreadSnapshot(
  reader: { readThread(id: string): Promise<CodexThreadSnapshot>;
    persistedTurnTerminal?(snapshot: CodexThreadSnapshot, turnId: string): Promise<'completed' | 'interrupted' | undefined> },
  snapshot: CodexThreadSnapshot,
  nowMs = Date.now(),
): Promise<CodexThreadSnapshot> {
  const latest = snapshot.turns.at(-1);
  if (!latest || !isInterruptedTurnStatus(latest.status)) return snapshot;
  const replace = (value: CodexThreadSnapshot, status: string) => ({ ...value,
    turns: value.turns.map((turn) => turn.id === latest.id ? { ...turn, status } : turn) });
  if (!reader.persistedTurnTerminal) {
    return isProvisionalInterruptedTurn(snapshot, latest, nowMs) ? replace(snapshot, 'inProgress') : snapshot;
  }
  const terminal = await reader.persistedTurnTerminal(snapshot, latest.id);
  if (!terminal) return replace(snapshot, 'inProgress');
  // Read again after observing the durable event so the last assistant item
  // isn't omitted from either frontend's final answer.
  const refreshed = await reader.readThread(snapshot.id);
  const refreshedTurn = refreshed.turns.find((turn) => turn.id === latest.id);
  const current = refreshedTurn ? refreshed : snapshot;
  return terminal === 'completed' && isInterruptedTurnStatus(refreshedTurn?.status ?? latest.status)
    ? replace(current, 'completed') : current;
}

export function isCodexSnapshotActive(snapshot: CodexThreadSnapshot): boolean {
  const latest = snapshot.turns.at(-1);
  if (!latest) return snapshot.status?.type === 'active';
  if (['completed', 'failed', 'interrupted', 'cancelled', 'canceled'].includes(latest.status.toLowerCase())) return false;
  return snapshot.status?.type === 'active' || ['inProgress', 'in_progress', 'running'].includes(latest.status);
}
