import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeCodexArchive,
  executeCodexCommand,
} from '../upstream-overrides/claudecodeui-1.25.2/server/codex-command-execution.mjs';

function createWriter() {
  return {
    messages: [],
    sessionId: null,
    send(message) {
      this.messages.push(message);
    },
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };
}

function commandDependencies(overrides = {}) {
  return {
    enqueueCodexDesktopMessageBridge: async () => {
      throw new Error('Desktop bridge should not be called');
    },
    queryCodex: async () => {},
    setSessionOrigin: () => {},
    ...overrides,
  };
}

function archiveDependencies(overrides = {}) {
  return {
    archiveSession: () => {},
    broadcastProjectsUpdated: async () => {},
    enqueueCodexDesktopArchive: async () => {
      throw new Error('Desktop archive should not be called');
    },
    getCodexSessions: async () => [],
    getSessionOrigin: () => null,
    ...overrides,
  };
}

test('后端会话：新建会话命令交给 Codex SDK，并标记为 backend', async () => {
  const calls = [];
  const writer = createWriter();
  const execution = executeCodexCommand({
    command: '创建测试会话',
    options: { projectPath: 'C:\\work\\mytest', model: 'gpt-test' },
    desktopSyncContext: { isMobile: false },
    writer,
  }, commandDependencies({
    queryCodex: async (command, options, receivedWriter) => calls.push({ command, options, writer: receivedWriter }),
  }));

  await execution.completion;

  assert.equal(execution.mode, 'backend');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '创建测试会话');
  assert.equal(calls[0].options.sessionId, undefined);
  assert.equal(calls[0].options.sessionOrigin, 'backend');
  assert.equal(calls[0].options.syncToDesktop, false);
  assert.equal(calls[0].writer, writer);
});

test('后端会话：发送消息携带已有 sessionId 续接 Codex SDK 会话', async () => {
  const calls = [];
  const execution = executeCodexCommand({
    command: '继续测试',
    options: { projectPath: 'C:\\work\\mytest', sessionId: 'backend-session-1' },
    desktopSyncContext: { isMobile: false },
    writer: createWriter(),
  }, commandDependencies({
    queryCodex: async (command, options) => calls.push({ command, options }),
  }));

  await execution.completion;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '继续测试');
  assert.equal(calls[0].options.sessionId, 'backend-session-1');
  assert.equal(calls[0].options.sessionOrigin, 'backend');
});

test('后端会话：归档只写入服务端归档并广播更新', async () => {
  const calls = [];
  const result = await executeCodexArchive({
    sessionId: 'backend-session-1',
    provider: 'codex',
    projectPath: 'C:\\work\\mytest',
    sessionTitle: '后端会话',
    sourceContext: { isMobile: true },
  }, archiveDependencies({
    getCodexSessions: async () => [{ id: 'backend-session-1', sessionOrigin: 'backend' }],
    archiveSession: (...args) => calls.push(['archive', ...args]),
    broadcastProjectsUpdated: async (event) => calls.push(['broadcast', event]),
  }));

  assert.equal(result.success, true);
  assert.equal(result.sessionOrigin, 'backend');
  assert.deepEqual(calls, [
    ['archive', 'backend-session-1', 'codex'],
    ['broadcast', { changeType: 'session_archived', provider: 'codex', sessionId: 'backend-session-1' }],
  ]);
});

test('App 会话：新建命令调用桌面桥并回传真实 sessionId', async () => {
  const bridgeCalls = [];
  const originCalls = [];
  const writer = createWriter();
  const execution = executeCodexCommand({
    command: '创建 App 测试会话',
    options: { projectPath: 'C:\\work\\mytest', newSession: true, executionMode: 'desktop-ui' },
    desktopSyncContext: { isMobile: true, userAgent: 'test' },
    writer,
  }, commandDependencies({
    enqueueCodexDesktopMessageBridge: async (payload) => {
      bridgeCalls.push(payload);
      return { skipped: false, sessionId: 'app-session-1' };
    },
    setSessionOrigin: (...args) => originCalls.push(args),
  }));

  await execution.completion;

  assert.equal(execution.mode, 'app');
  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].newSession, true);
  assert.equal(bridgeCalls[0].sessionId, null);
  assert.equal(bridgeCalls[0].sourceContext.isMobile, true);
  assert.equal(writer.sessionId, 'app-session-1');
  assert.deepEqual(originCalls, [['app-session-1', 'codex', 'app']]);
  assert.deepEqual(writer.messages.map((message) => message.type), [
    'codex-desktop-command-submitted',
    'session-created',
    'codex-desktop-command-delivered',
  ]);
});

test('App 会话：发送消息按已有 sessionId 调用桌面桥', async () => {
  const bridgeCalls = [];
  const writer = createWriter();
  const execution = executeCodexCommand({
    command: '继续 App 测试',
    options: { projectPath: 'C:\\work\\mytest', sessionId: 'app-session-1', executionMode: 'desktop-ui' },
    desktopSyncContext: { isMobile: true },
    writer,
  }, commandDependencies({
    enqueueCodexDesktopMessageBridge: async (payload) => {
      bridgeCalls.push(payload);
      return { skipped: false };
    },
  }));

  await execution.completion;

  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].newSession, false);
  assert.equal(bridgeCalls[0].sessionId, 'app-session-1');
  assert.equal(bridgeCalls[0].message, '继续 App 测试');
  assert.equal(writer.sessionId, null);
  assert.deepEqual(writer.messages.map((message) => message.type), [
    'codex-desktop-command-submitted',
    'codex-desktop-command-delivered',
  ]);
});

test('App 会话：先归档桌面会话，成功后再写入服务端归档', async () => {
  const calls = [];
  const result = await executeCodexArchive({
    sessionId: 'app-session-1',
    provider: 'codex',
    projectPath: 'C:\\work\\mytest',
    sessionTitle: 'App 会话',
    sourceContext: { isMobile: true },
  }, archiveDependencies({
    getCodexSessions: async () => [{ id: 'app-session-1', sessionOrigin: 'app' }],
    enqueueCodexDesktopArchive: async (payload) => {
      calls.push(['desktop-archive', payload]);
      return { skipped: false };
    },
    archiveSession: (...args) => calls.push(['archive', ...args]),
    broadcastProjectsUpdated: async (event) => calls.push(['broadcast', event]),
  }));

  assert.equal(result.success, true);
  assert.equal(result.sessionOrigin, 'app');
  assert.equal(calls[0][0], 'desktop-archive');
  assert.equal(calls[0][1].sessionId, 'app-session-1');
  assert.equal(calls[0][1].sessionTitleHint, 'App 会话');
  assert.deepEqual(calls.slice(1), [
    ['archive', 'app-session-1', 'codex'],
    ['broadcast', { changeType: 'session_archived', provider: 'codex', sessionId: 'app-session-1' }],
  ]);
});
