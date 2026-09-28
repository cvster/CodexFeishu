import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexAppMessageRelayArgs,
  enqueueCodexAppMessageRelay,
} from '../upstream-overrides/claudecodeui-1.25.2/server/codex-app-message-relay.mjs';
import { executeCodexCommand } from '../upstream-overrides/claudecodeui-1.25.2/server/codex-command-execution.mjs';

function createWriter() {
  return {
    events: [],
    sessionId: null,
    send(event) {
      this.events.push(event);
    },
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };
}

test('构造原生 Codex queue 参数，并保留消息原文', () => {
  const result = buildCodexAppMessageRelayArgs({
    sessionId: ' app-session-id ',
    projectPath: ' D:\\dorit\\mytest ',
    message: '  结构化测试369  ',
  });

  assert.deepEqual(result, [
    'queue', '--thread', 'app-session-id',
    '--message', '  结构化测试369  ',
    '--sandbox', 'danger-full-access',
    '-c', 'approval_policy="never"',
    '-c', 'shell_environment_policy.inherit="all"',
    '-C', 'D:\\dorit\\mytest',
  ]);
});

test('已有 App 会话只调用原生队列', async () => {
  const calls = [];
  const writer = createWriter();
  const execution = executeCodexCommand({
    command: '早上好22',
    options: {
      executionMode: 'desktop-ui',
      sessionId: 'app-session-id',
      projectPath: 'D:\\dorit\\mytest',
    },
    desktopSyncContext: { isMobile: true },
    writer,
  }, {
    enqueueCodexAppMessageRelay: async (payload) => {
      calls.push(['relay', payload]);
      return { skipped: false, sessionId: payload.sessionId };
    },
    enqueueCodexDesktopMessageBridge: async (payload) => {
      calls.push(['desktop', payload]);
      return { skipped: false };
    },
    queryCodex: async () => {},
    setSessionOrigin: () => {},
  });

  assert.equal(execution.mode, 'app');
  await execution.completion;
  assert.deepEqual(calls.map(([kind]) => kind), ['relay']);
  assert.equal(calls[0][1].message, '早上好22');
  assert.ok(writer.events.some((event) => event.type === 'codex-desktop-command-delivered'));
});

test('新建 App 会话仍使用原桌面自动化链路', async () => {
  const calls = [];
  const writer = createWriter();
  const execution = executeCodexCommand({
    command: '新会话消息',
    options: {
      executionMode: 'desktop-ui',
      newSession: true,
      projectPath: 'D:\\dorit\\mytest',
    },
    desktopSyncContext: { isMobile: true },
    writer,
  }, {
    enqueueCodexAppMessageRelay: async (payload) => {
      calls.push(['relay', payload]);
      return { skipped: false };
    },
    enqueueCodexDesktopMessageBridge: async (payload) => {
      calls.push(['desktop', payload]);
      return { skipped: false, sessionId: 'new-app-session-id' };
    },
    queryCodex: async () => {},
    setSessionOrigin: () => {},
  });

  await execution.completion;
  assert.deepEqual(calls.map(([kind]) => kind), ['desktop']);
  assert.equal(writer.sessionId, 'new-app-session-id');
});

test('已有 App 会话通过原生 queue 直接投递', async () => {
  let invocation = null;

  const result = await enqueueCodexAppMessageRelay({
    sessionId: 'app-session-id',
    projectPath: 'D:\\dorit\\mytest',
    message: '结构化测试369',
  }, {
    runRelayCommand: async (args, options) => {
      invocation = { args, options };
      return 'Queued';
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(result.sessionId, 'app-session-id');
  assert.deepEqual(invocation.args.slice(0, 5), [
    'queue', '--thread', 'app-session-id', '--message', '结构化测试369',
  ]);
  assert.equal(invocation.options.cwd, 'D:\\dorit\\mytest');
});
