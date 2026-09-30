import { describe, expect, it } from 'vitest';
import {
  isProvisionalInterruptedTurn,
} from '../../../src/session/codex-turn-status.js';
import type {
  CodexThreadSnapshot,
  CodexThreadTurn,
} from '../../../src/session/codex-thread-reader.js';

describe('isProvisionalInterruptedTurn', () => {
  it('accepts an omitted completion timestamp as an unconfirmed interruption', () => {
    const nowMs = 100_000;
    const turn: CodexThreadTurn = {
      id: 'turn-transient',
      status: 'interrupted',
      items: [],
    };
    const snapshot: CodexThreadSnapshot = {
      id: 'thread-1',
      updatedAtMs: nowMs,
      turns: [turn],
    };

    expect(isProvisionalInterruptedTurn(snapshot, turn, nowMs)).toBe(true);
  });

  it('does not hide a committed interruption indefinitely', () => {
    const nowMs = 100_000;
    const turn: CodexThreadTurn = {
      id: 'turn-stopped',
      status: 'interrupted',
      completedAtMs: nowMs - 1_000,
      items: [],
    };
    const snapshot: CodexThreadSnapshot = {
      id: 'thread-1',
      updatedAtMs: nowMs,
      turns: [turn],
    };

    expect(isProvisionalInterruptedTurn(snapshot, turn, nowMs)).toBe(false);
  });
});
