import { open, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const INITIAL_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Confirms a turn's terminal state from Codex's durable rollout events.
 *
 * A read-only app-server can project a turn owned by another app-server as
 * `interrupted`. The rollout is the cross-process source of truth: only a
 * persisted task/turn completion or abort seals the turn for this helper.
 */
export class CodexTurnTerminalVerifier {
  #cursors = new Map();

  async terminalFor(rolloutPath, turnId) {
    const filePath = normalizeLocalPath(rolloutPath);
    if (!filePath || !turnId) return undefined;

    let info;
    try {
      info = await stat(filePath);
    } catch {
      return undefined;
    }
    if (!info.isFile()) return undefined;

    let cursor = this.#cursors.get(filePath);
    if (!cursor || info.size < cursor.offset) {
      cursor = {
        offset: Math.max(0, info.size - INITIAL_TAIL_BYTES),
        carry: '',
        skipFirstPartialLine: info.size > INITIAL_TAIL_BYTES,
        activeTurnId: undefined,
        unscopedAbortSeen: false,
        terminals: new Map(),
      };
      this.#cursors.set(filePath, cursor);
    }
    if (info.size > cursor.offset) {
      await this.#readAppended(filePath, info.size, cursor);
    }
    return cursor.terminals.get(turnId)
      ?? (cursor.unscopedAbortSeen ? 'interrupted' : undefined);
  }

  async #readAppended(filePath, size, cursor) {
    const length = size - cursor.offset;
    const buffer = Buffer.allocUnsafe(length);
    const handle = await open(filePath, 'r');
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
      cursor.offset += bytesRead;
      const lines = `${cursor.carry}${buffer.subarray(0, bytesRead).toString('utf8')}`.split(/\r?\n/);
      cursor.carry = lines.pop() ?? '';
      if (cursor.skipFirstPartialLine && lines.length > 0) {
        lines.shift();
        cursor.skipFirstPartialLine = false;
      }
      for (const line of lines) recordTerminalEvent(line, cursor);
    } finally {
      await handle.close();
    }
  }
}

function recordTerminalEvent(line, cursor) {
  if (
    !line.includes('task_started') &&
    !line.includes('turn_started') &&
    !line.includes('task_complete') &&
    !line.includes('turn_complete') &&
    !line.includes('turn_aborted')
  ) {
    return;
  }

  let envelope;
  try {
    envelope = JSON.parse(line);
  } catch {
    return;
  }
  if (envelope?.type !== 'event_msg') return;

  const type = envelope.payload?.type;
  const turnId = typeof envelope.payload?.turn_id === 'string'
    ? envelope.payload.turn_id
    : undefined;
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
    cursor.unscopedAbortSeen = true;
  }
}

function normalizeLocalPath(value) {
  if (typeof value !== 'string' || !value) return undefined;
  if (!value.startsWith('file:')) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}
