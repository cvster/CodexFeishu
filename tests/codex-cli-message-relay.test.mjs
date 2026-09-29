import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  buildCodexQueueArgs,
  enqueueCodexCliMessage,
  queueCodexCliThreadMessage,
  runCodexCliThreadTurn,
} from '../upstream-overrides/claudecodeui-1.25.2/server/codex-cli-message-relay.mjs';

function createFakeClient(calls) {
  return {
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'thread/start') return { thread: { id: 'new-thread' } };
      return {};
    },
    notify(method) { calls.push([method]); },
    waitForNotification(method, predicate) {
      calls.push([`wait:${method}`]);
      assert.equal(predicate({ threadId: calls.some(([name]) => name === 'thread/resume') ? 'thread-1' : 'new-thread' }), true);
      const threadId = calls.some(([name]) => name === 'thread/resume') ? 'thread-1' : 'new-thread';
      return Promise.resolve({ threadId, turn: { status: 'completed' } });
    },
    async close() { calls.push(['close']); },
  };
}

test('已有会话通过原生 codex queue 提交，避免争抢 app-server writer lock', async () => {
  const calls = [];
  const result = await runCodexCliThreadTurn({
    sessionId: 'thread-1',
    projectPath: 'D:\\dorit\\mytest',
    message: '继续',
    model: 'gpt-6-sol',
  }, {
    queueThreadMessage: async (payload) => {
      calls.push(payload);
      return { skipped: false, sessionId: payload.sessionId, queueMessageId: 'queue-1' };
    },
  });

  assert.equal(result.sessionId, 'thread-1');
  assert.equal(result.queueMessageId, 'queue-1');
  assert.deepEqual(calls[0], {
    sessionId: 'thread-1',
    projectPath: 'D:\\dorit\\mytest',
    message: '继续',
    model: 'gpt-6-sol',
  });
});

test('codex queue 参数包含共享会话、模型、推理强度与工作目录', () => {
  assert.deepEqual(buildCodexQueueArgs({
    sessionId: 'thread-1',
    message: '继续',
    cwd: 'D:\\dorit\\mytest',
    model: 'gpt-6-sol',
    modelReasoningEffort: 'high',
  }), [
    'queue', '--thread', 'thread-1', '--message', '继续',
    '--sandbox', 'danger-full-access',
    '-c', 'approval_policy="never"',
    '-c', 'shell_environment_policy.inherit="all"',
    '--model', 'gpt-6-sol',
    '-c', 'model_reasoning_effort="high"',
    '-C', 'D:\\dorit\\mytest',
  ]);
});

test('codex queue 成功时解析原生队列消息 ID', async () => {
  const spawnImpl = (_cliPath, args, options) => {
    calls.push({ args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end('Queued message queue-42 for thread thread-1.\n');
      child.emit('exit', 0, null);
    });
    return child;
  };
  const calls = [];
  const result = await queueCodexCliThreadMessage({
    sessionId: 'thread-1',
    projectPath: 'D:\\dorit\\mytest',
    message: '继续',
  }, { cliPath: 'codex.exe', spawnImpl });

  assert.equal(result.queueMessageId, 'queue-42');
  assert.equal(calls[0].args[0], 'queue');
  assert.equal(calls[0].options.cwd, 'D:\\dorit\\mytest');
});

test('新会话通过 app-server 创建并启动首轮', async () => {
  const calls = [];
  let createdSessionId = null;
  const result = await runCodexCliThreadTurn({
    projectPath: 'D:\\dorit\\mytest',
    message: '新任务',
    model: 'gpt-6-sol',
    modelReasoningEffort: 'high',
    onSessionCreated: (sessionId) => { createdSessionId = sessionId; },
  }, {
    createClient: () => createFakeClient(calls),
    resolveProjectId: async () => 'project-1',
  });

  assert.equal(result.sessionId, 'new-thread');
  assert.equal(createdSessionId, 'new-thread');
  assert.deepEqual(calls.find(([method]) => method === 'thread/start')[1], {
    cwd: 'D:\\dorit\\mytest',
    projectId: 'project-1',
    model: 'gpt-6-sol',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    threadSource: 'user',
  });
  assert.deepEqual(calls.find(([method]) => method === 'turn/start')[1], {
    threadId: 'new-thread',
    input: [{ type: 'text', text: '新任务', text_elements: [] }],
    model: 'gpt-6-sol',
    effort: 'high',
  });
});

test('同一会话的多条消息按顺序执行', async () => {
  const order = [];
  const dependencies = {
    runThreadTurn: async (payload) => {
      order.push(`start:${payload.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${payload.message}`);
      return { skipped: false, sessionId: payload.sessionId };
    },
  };
  await Promise.all([
    enqueueCodexCliMessage({ sessionId: 'thread-1', projectPath: 'D:\\dorit\\mytest', message: '一' }, dependencies),
    enqueueCodexCliMessage({ sessionId: 'thread-1', projectPath: 'D:\\dorit\\mytest', message: '二' }, dependencies),
  ]);
  assert.deepEqual(order, ['start:一', 'end:一', 'start:二', 'end:二']);
});
