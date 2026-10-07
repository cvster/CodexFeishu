import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { CodexTurnTerminalVerifier } from '../upstream-overrides/claudecodeui-1.25.2/server/codex-turn-terminal-verifier.mjs';

test('rollout verifier 区分暂态 interrupted 与持久化完成', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mobile-codex-terminal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  await writeFile(rolloutPath, `${event('task_started', 'turn-1')}\n`, 'utf8');
  const verifier = new CodexTurnTerminalVerifier();

  assert.equal(await verifier.terminalFor(rolloutPath, 'turn-1'), undefined);
  await appendFile(rolloutPath, `${event('task_complete', 'turn-1')}\n`, 'utf8');
  assert.equal(await verifier.terminalFor(rolloutPath, 'turn-1'), 'completed');
});

test('rollout verifier 识别 file URL 和真实 turn_aborted', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mobile-codex-terminal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  await writeFile(rolloutPath, `${event('turn_aborted', 'turn-stop')}\n`, 'utf8');

  const verifier = new CodexTurnTerminalVerifier();
  assert.equal(
    await verifier.terminalFor(pathToFileURL(rolloutPath).href, 'turn-stop'),
    'interrupted',
  );
});

test('rollout verifier 将无 turn_id 的 abort 绑定到活动 turn', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mobile-codex-terminal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  await writeFile(
    rolloutPath,
    `${event('task_started', 'turn-legacy')}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted' } })}\n`,
    'utf8',
  );

  const verifier = new CodexTurnTerminalVerifier();
  assert.equal(await verifier.terminalFor(rolloutPath, 'turn-legacy'), 'interrupted');
});

function event(type, turnId) {
  return JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turnId } });
}
