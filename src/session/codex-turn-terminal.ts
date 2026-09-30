import { open, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export type CodexPersistedTurnTerminal = 'completed' | 'interrupted';

interface RolloutCursor {
  offset: number;
  carry: string;
  skipFirstPartialLine: boolean;
  activeTurnId?: string;
  unscopedAbortSeen: boolean;
  terminals: Map<string, CodexPersistedTurnTerminal>;
}

const INITIAL_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Confirms terminal turn state from Codex's durable rollout events.
 *
 * A read-only app-server intentionally projects an unfinished tail turn as
 * `interrupted` when that turn is live in another app-server. The rollout is
 * the durable source used by app-server itself: `task_complete` and
 * `turn_aborted` are unambiguous and survive process boundaries.
 */
export class CodexTurnTerminalVerifier {
  private readonly cursors = new Map<string, RolloutCursor>();

  async terminalFor(
    rolloutPath: string | undefined,
    turnId: string,
  ): Promise<CodexPersistedTurnTerminal | undefined> {
    const path = localPath(rolloutPath);
    if (!path) return undefined;

    let info;
    try {
      info = await stat(path);
    } catch {
      return undefined;
    }
    if (!info.isFile()) return undefined;

    let cursor = this.cursors.get(path);
    if (!cursor || info.size < cursor.offset) {
      cursor = {
        offset: Math.max(0, info.size - INITIAL_TAIL_BYTES),
        carry: '',
        skipFirstPartialLine: info.size > INITIAL_TAIL_BYTES,
        unscopedAbortSeen: false,
        terminals: new Map(),
      };
      this.cursors.set(path, cursor);
    }
    if (info.size > cursor.offset) {
      await this.readAppended(path, info.size, cursor);
    }
    return cursor.terminals.get(turnId) ??
      (cursor.unscopedAbortSeen ? 'interrupted' : undefined);
  }

  private async readAppended(path: string, size: number, cursor: RolloutCursor): Promise<void> {
    const length = size - cursor.offset;
    const buffer = Buffer.allocUnsafe(length);
    const handle = await open(path, 'r');
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
      cursor.offset += bytesRead;
      const text = cursor.carry + buffer.subarray(0, bytesRead).toString('utf8');
      const lines = text.split(/\r?\n/);
      cursor.carry = lines.pop() ?? '';
      if (cursor.skipFirstPartialLine && lines.length > 0) {
        lines.shift();
        cursor.skipFirstPartialLine = false;
      }
      for (const line of lines) recordEvent(line, cursor);
    } finally {
      await handle.close();
    }
  }
}

function recordEvent(line: string, cursor: RolloutCursor): void {
  if (
    !line.includes('task_started') &&
    !line.includes('turn_started') &&
    !line.includes('task_complete') &&
    !line.includes('turn_complete') &&
    !line.includes('turn_aborted')
  ) {
    return;
  }
  let envelope: Record<string, unknown> | undefined;
  try {
    envelope = recordValue(JSON.parse(line));
  } catch {
    return;
  }
  if (envelope?.type !== 'event_msg') return;
  const payload = recordValue(envelope.payload);
  const type = stringValue(payload?.type);
  const turnId = stringValue(payload?.turn_id);
  if ((type === 'task_started' || type === 'turn_started') && turnId) {
    cursor.activeTurnId = turnId;
    cursor.unscopedAbortSeen = false;
    return;
  }
  if ((type === 'task_complete' || type === 'turn_complete') && turnId) {
    cursor.terminals.set(turnId, 'completed');
    if (cursor.activeTurnId === turnId) cursor.activeTurnId = undefined;
    cursor.unscopedAbortSeen = false;
    return;
  }
  if (type !== 'turn_aborted') return;
  const abortedTurnId = turnId ?? cursor.activeTurnId;
  if (abortedTurnId) {
    cursor.terminals.set(abortedTurnId, 'interrupted');
    if (cursor.activeTurnId === abortedTurnId) cursor.activeTurnId = undefined;
    cursor.unscopedAbortSeen = false;
  } else {
    // Legacy rollouts can omit turn_id. This still closes the currently
    // reconstructed tail turn, matching app-server's own recovery logic.
    cursor.unscopedAbortSeen = true;
  }
}

function localPath(input: string | undefined): string | undefined {
  if (!input) return undefined;
  if (!input.startsWith('file:')) return input;
  try {
    return fileURLToPath(input);
  } catch {
    return undefined;
  }
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}
