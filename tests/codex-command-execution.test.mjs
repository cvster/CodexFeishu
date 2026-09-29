import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeCodexArchive,
  executeCodexCommand,
} from '../upstream-overrides/claudecodeui-1.25.2/server/codex-command-execution.mjs';

function createWriter() {
  return {
    events: [],
    sessionId: null,
    send(event) { this.events.push(event); },
    setSessionId(sessionId) { this.sessionId = sessionId; },
  };
}

test('所有会话命令统一走 Codex CLI', async () => {
  const writer = createWriter();
  const execution = executeCodexCommand({
    command: '继续处理',
    options: { sessionId: 'thread-1', projectPath: 'D:\\dorit\\mytest' },
    writer,
  }, {
    enqueueCodexCliMessage: async (payload) => ({ skipped: false, sessionId: payload.sessionId }),
  });

  assert.equal(execution.mode, 'cli');
  await execution.completion;
  assert.deepEqual(writer.events.map((event) => event.type), [
    'codex-cli-command-submitted',
    'codex-cli-command-delivered',
  ]);
});

test('新 CLI 会话创建后立即回填真实会话 ID', async () => {
  const writer = createWriter();
  const execution = executeCodexCommand({
    command: '新任务',
    options: { newSession: true, projectPath: 'D:\\dorit\\mytest' },
    writer,
  }, {
    enqueueCodexCliMessage: async (payload) => {
      payload.onSessionCreated('new-thread');
      return { skipped: false, sessionId: 'new-thread' };
    },
  });

  await execution.completion;
  assert.equal(writer.sessionId, 'new-thread');
  assert.deepEqual(writer.events.map((event) => event.type), [
    'codex-cli-command-submitted',
    'session-created',
    'codex-cli-command-delivered',
  ]);
});

test('CLI 会话通过 app-server 原生归档，不依赖桌面侧边栏', async () => {
  const calls = [];
  const result = await executeCodexArchive({
    sessionId: 'thread-1',
    provider: 'codex',
    projectPath: 'D:\\dorit\\mytest',
  }, {
    archiveCodexAppThread: async (payload) => {
      calls.push(['native-archive', payload]);
      return { skipped: false };
    },
    archiveSession: (...args) => calls.push(['local-archive', args]),
    broadcastProjectsUpdated: async (payload) => calls.push(['broadcast', payload]),
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls[0], ['native-archive', {
    sessionId: 'thread-1',
    projectPath: 'D:\\dorit\\mytest',
  }]);
  assert.equal(calls.some(([kind]) => kind === 'local-archive'), true);
  assert.equal(calls.some(([kind]) => kind === 'broadcast'), true);
});

test('原生归档失败时不写入网页本地归档状态', async () => {
  let locallyArchived = false;
  const result = await executeCodexArchive({
    sessionId: 'thread-2',
    provider: 'codex',
    projectPath: 'D:\\dorit\\mytest',
  }, {
    archiveCodexAppThread: async () => ({
      skipped: true,
      reason: 'error',
      error: 'native archive failed',
    }),
    archiveSession: () => {
      locallyArchived = true;
    },
    broadcastProjectsUpdated: async () => {},
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 409);
  assert.equal(locallyArchived, false);
});
