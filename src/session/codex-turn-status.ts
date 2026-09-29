import type { CodexThreadSnapshot, CodexThreadTurn } from './codex-thread-reader';

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
  if (turn.completedAtMs !== null) return false;
  if (snapshot.updatedAtMs === undefined) return false;
  return nowMs - snapshot.updatedAtMs <= PROVISIONAL_INTERRUPTED_WINDOW_MS;
}
