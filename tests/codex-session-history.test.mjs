import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCodexResponseUserMessageText,
  selectCodexRolloutCandidate,
} from '../upstream-overrides/claudecodeui-1.25.2/server/codex-session-history.mjs';

test('优先使用 Codex state 中当前续写 rollout，而不是最老的同 ID 文件', () => {
  const sessionId = 'thread-1';
  const current = `/sessions/current-${sessionId}-turn-3.jsonl`;
  assert.equal(selectCodexRolloutCandidate(sessionId, current, [
    { path: `/sessions/old-${sessionId}.jsonl`, mtimeMs: 1 },
    { path: current, mtimeMs: 3 },
    { path: `/sessions/middle-${sessionId}-turn-2.jsonl`, mtimeMs: 2 },
  ]), current);
});

test('state 路径失效时选择最近修改的 rollout', () => {
  const sessionId = 'thread-1';
  assert.equal(selectCodexRolloutCandidate(sessionId, '/missing/thread-1.jsonl', [
    { path: `/sessions/old-${sessionId}.jsonl`, mtimeMs: 1 },
    { path: `/sessions/new-${sessionId}.jsonl`, mtimeMs: 9 },
  ]), `/sessions/new-${sessionId}.jsonl`);
});

test('识别新版 response_item 中真正的用户消息并排除环境上下文', () => {
  assert.equal(getCodexResponseUserMessageText({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '最新问题' }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
  }), '最新问题');

  assert.equal(getCodexResponseUserMessageText({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>' }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context'] },
  }), null);
});
