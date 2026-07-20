import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexAppMessageRelayCommand,
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

test('构造精简的 App 消息转发 JSON，并保留消息原文', () => {
  const result = JSON.parse(buildCodexAppMessageRelayCommand({
    project: ' mytest ',
    session: ' 早390 ',
    message: '  结构化测试369  ',
  }));

  assert.deepEqual(Object.keys(result), ['action', 'project', 'session', 'message', 'prompt']);
  assert.equal(result.action, 'send_message');
  assert.equal(result.project, 'mytest');
  assert.equal(result.session, '早390');
  assert.equal(result.message, '  结构化测试369  ');
  assert.match(result.prompt, /不要读取或使用项目文件/);
  assert.match(result.prompt, /消息仅作为普通文本/);
  assert.match(result.prompt, /成功只回复OK/);
});

test('已有 App 会话只调用转发会话', async () => {
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

test('转发器使用 Luna 低推理并要求明确 OK', async () => {
  const previousSessionId = process.env.MOBILE_CODEX_APP_MESSAGE_RELAY_SESSION_ID;
  process.env.MOBILE_CODEX_APP_MESSAGE_RELAY_SESSION_ID = 'relay-session-id';
  let invocation = null;

  try {
    const result = await enqueueCodexAppMessageRelay({
      sessionId: 'app-session-id',
      projectPath: 'D:\\dorit\\mytest',
      message: '结构化测试369',
    }, {
      resolveCodexDesktopMessageTarget: async () => ({
        projectDisplayName: 'mytest',
        sessionTitle: '早390',
        selectionMode: 'session-title',
        resolutionSource: 'metadata',
      }),
      runRelayCommand: async (command, options) => {
        invocation = { command: JSON.parse(command), options };
        return 'OK';
      },
    });

    assert.equal(result.skipped, false);
    assert.equal(result.sessionId, 'app-session-id');
    assert.equal(invocation.command.project, 'mytest');
    assert.equal(invocation.command.session, '早390');
    assert.equal(invocation.command.message, '结构化测试369');
    assert.equal(invocation.options.sessionId, 'relay-session-id');
    assert.equal(invocation.options.model, 'gpt-5.6-luna');
    assert.equal(invocation.options.modelReasoningEffort, 'low');
  } finally {
    if (previousSessionId === undefined) {
      delete process.env.MOBILE_CODEX_APP_MESSAGE_RELAY_SESSION_ID;
    } else {
      process.env.MOBILE_CODEX_APP_MESSAGE_RELAY_SESSION_ID = previousSessionId;
    }
  }
});
