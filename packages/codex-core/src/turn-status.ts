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
