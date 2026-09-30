import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexTurnTerminalVerifier } from '../../../src/session/codex-turn-terminal.js';

describe('CodexTurnTerminalVerifier', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('distinguishes durable completion from app-server projected interruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-terminal-'));
    cleanup.push(dir);
    const rollout = join(dir, 'rollout.jsonl');
    await writeFile(rollout, `${event('task_started', 'turn-1')}\n`, 'utf8');
    const verifier = new CodexTurnTerminalVerifier();

    await expect(verifier.terminalFor(rollout, 'turn-1')).resolves.toBeUndefined();
    await appendFile(rollout, `${event('task_complete', 'turn-1')}\n`, 'utf8');
    await expect(verifier.terminalFor(rollout, 'turn-1')).resolves.toBe('completed');
  });

  it('recognizes explicit aborts and file URLs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-terminal-'));
    cleanup.push(dir);
    const rollout = join(dir, 'rollout.jsonl');
    await writeFile(rollout, `${event('turn_aborted', 'turn-stop')}\n`, 'utf8');
    const verifier = new CodexTurnTerminalVerifier();

    await expect(
      verifier.terminalFor(pathToFileURL(rollout).href, 'turn-stop'),
    ).resolves.toBe('interrupted');
  });

  it('associates legacy unscoped aborts with the active turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-terminal-'));
    cleanup.push(dir);
    const rollout = join(dir, 'rollout.jsonl');
    await writeFile(
      rollout,
      `${event('task_started', 'turn-legacy')}\n${eventWithoutTurnId('turn_aborted')}\n`,
      'utf8',
    );
    const verifier = new CodexTurnTerminalVerifier();

    await expect(verifier.terminalFor(rollout, 'turn-legacy')).resolves.toBe('interrupted');
  });
});

function event(type: string, turnId: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type, turn_id: turnId },
  });
}

function eventWithoutTurnId(type: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type, reason: 'interrupted' },
  });
}
