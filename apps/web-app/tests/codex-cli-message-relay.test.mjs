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
      if (method === 'thread/read') return { thread: { id: 'new-thread', turns: [] } };
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

test('codex queue 使用共享 daemon 的最小参数，沿用已有会话配置', () => {
  assert.deepEqual(buildCodexQueueArgs({
    sessionId: 'thread-1',
    message: '继续',
    cwd: 'D:\\dorit\\mytest',
    model: 'gpt-6-sol',
    modelReasoningEffort: 'high',
  }), [
    'queue', '--thread', 'thread-1', '--message', '继续',
  ]);
});

test('codex queue 可显式连接桌面共享 daemon', () => {
  assert.deepEqual(buildCodexQueueArgs({
    sessionId: 'thread-1',
    message: '继续',
    remote: 'unix://',
  }), [
    'queue', '--remote', 'unix://', '--thread', 'thread-1', '--message', '继续',
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
  let readCount = 0;
  const client = {
    async request(method) {
      if (method === 'initialize') return {};
      if (method === 'thread/read') {
        readCount += 1;
        return readCount === 1
          ? { thread: { turns: [{ id: 'old-turn', status: 'completed', items: [] }] } }
          : {
              thread: {
                turns: [{
                  id: 'new-turn',
                  status: 'completed',
                  items: [{ type: 'userMessage', content: [{ type: 'text', text: '继续' }] }],
                }],
              },
            };
      }
      return {};
    },
    notify() {},
    async close() {},
  };
  const result = await queueCodexCliThreadMessage({
    sessionId: 'thread-1',
    projectPath: 'D:\\dorit\\mytest',
    message: '继续',
  }, { cliPath: 'codex.exe', spawnImpl, createClient: () => client });

  assert.equal(result.queueMessageId, 'queue-42');
  assert.equal(calls[0].args[0], 'queue');
  assert.equal(calls[0].options.cwd, 'D:\\dorit\\mytest');
  assert.equal(readCount, 2);
});

test('已有会话只读历史并通过共享队列投递，不争抢 writer', async () => {
  const calls = [];
  let readCount = 0;
  const client = {
    async request(method) {
      calls.push(method);
      if (method === 'thread/read') {
        readCount += 1;
        return readCount === 1
          ? { thread: { turns: [] } }
          : {
              thread: {
                turns: [{
                  id: 'queued-turn',
                  status: 'completed',
                  items: [{ type: 'userMessage', content: [{ type: 'text', text: '继续' }] }],
                }],
              },
            };
      }
      return {};
    },
    notify() {},
    async close() {},
  };
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end('Queued message queue-1 for thread thread-1.\n');
      child.emit('exit', 0, null);
    });
    return child;
  };

  await queueCodexCliThreadMessage({
    sessionId: 'thread-1',
    projectPath: 'D:\\dorit\\mytest',
    message: '继续',
  }, { cliPath: 'codex.exe', spawnImpl, createClient: () => client });

  assert.deepEqual(calls, ['initialize', 'thread/read', 'thread/read']);
});

test('旧会话忽略只读 app-server 的暂态 interrupted 并等待真实完成', async () => {
  const calls = [];
  let readCount = 0;
  const client = {
    async request(method) {
      calls.push(method);
      if (method !== 'thread/read') return {};
      readCount += 1;
      if (readCount === 1) return { thread: { path: 'rollout.jsonl', turns: [] } };
      return {
        thread: {
          path: 'rollout.jsonl',
          turns: [{
            id: 'queued-turn',
            status: readCount === 2 ? 'interrupted' : 'completed',
            completedAt: readCount === 2 ? Date.now() / 1000 : undefined,
            items: [{ type: 'userMessage', content: [{ type: 'text', text: '继续' }] }],
          }],
        },
      };
    },
    notify() {},
    async close() {},
  };

  await queueCodexCliThreadMessage({
    sessionId: 'thread-1',
    projectPath: 'D:\\dorit\\mytest',
    message: '继续',
  }, {
    cliPath: 'codex.exe',
    spawnImpl: successfulQueueChild,
    createClient: () => client,
    pollIntervalMs: 0,
    resumeFallbackMs: 0,
    terminalVerifier: { terminalFor: async () => undefined },
  });

  assert.equal(calls.includes('thread/resume'), false);
  assert.equal(readCount, 3);
});

test('旧会话只在 rollout 持久化中断后结束等待', async () => {
  let readCount = 0;
  const client = {
    async request(method) {
      if (method !== 'thread/read') return {};
      readCount += 1;
      return readCount === 1
        ? { thread: { path: 'rollout.jsonl', turns: [] } }
        : {
            thread: {
              path: 'rollout.jsonl',
              turns: [{
                id: 'queued-turn',
                status: 'interrupted',
                items: [{ type: 'userMessage', content: [{ type: 'text', text: '继续' }] }],
              }],
            },
          };
    },
    notify() {},
    async close() {},
  };

  await assert.rejects(
    queueCodexCliThreadMessage({
      sessionId: 'thread-1',
      projectPath: 'D:\\dorit\\mytest',
      message: '继续',
    }, {
      cliPath: 'codex.exe',
      spawnImpl: successfulQueueChild,
      createClient: () => client,
      pollIntervalMs: 0,
      terminalVerifier: { terminalFor: async () => 'interrupted' },
    }),
    /queued turn interrupted/,
  );
  assert.equal(readCount, 3);
});

test('旧会话的活动 turn 被投影为 interrupted 时不会争抢 writer', async () => {
  const calls = [];
  let readCount = 0;
  const projectedTurn = {
    id: 'desktop-turn',
    status: 'interrupted',
    completedAt: null,
    items: [],
  };
  const client = {
    async request(method) {
      calls.push(method);
      if (method !== 'thread/read') return {};
      readCount += 1;
      if (readCount <= 3) {
        return { thread: { path: 'rollout.jsonl', turns: [projectedTurn] } };
      }
      return {
        thread: {
          path: 'rollout.jsonl',
          turns: [projectedTurn, {
            id: 'queued-turn',
            status: 'completed',
            items: [{ type: 'userMessage', content: [{ type: 'text', text: '继续' }] }],
          }],
        },
      };
    },
    notify() {},
    async close() {},
  };

  await queueCodexCliThreadMessage({
    sessionId: 'thread-1',
    projectPath: 'D:\\dorit\\mytest',
    message: '继续',
  }, {
    cliPath: 'codex.exe',
    spawnImpl: successfulQueueChild,
    createClient: () => client,
    pollIntervalMs: 0,
    resumeFallbackMs: 0,
    terminalVerifier: { terminalFor: async () => undefined },
  });

  assert.equal(calls.includes('thread/resume'), false);
});

test('共享队列无人消费时不会在观察客户端加载 writer', async () => {
  const calls = [];
  let resumed = false;
  const client = {
    async request(method) {
      calls.push(method);
      if (method === 'thread/resume') {
        resumed = true;
        return {};
      }
      if (method === 'thread/read') {
        return resumed
          ? { thread: { turns: [{
              id: 'queued-turn',
              status: 'completed',
              items: [{ type: 'userMessage', content: [{ type: 'text', text: '继续' }] }],
            }] } }
          : { thread: { turns: [] } };
      }
      return {};
    },
    notify() {},
    async close() {},
  };
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end('Queued message queue-1 for thread thread-1.\n');
      child.emit('exit', 0, null);
    });
    return child;
  };

  await assert.rejects(queueCodexCliThreadMessage({
    sessionId: 'thread-1',
    projectPath: 'D:\\dorit\\mytest',
    message: '继续',
  }, {
    cliPath: 'codex.exe',
    spawnImpl,
    createClient: () => client,
    turnTimeoutMs: 10,
    pollIntervalMs: 0,
  }), /Codex queued turn timed out/);

  assert.equal(calls.filter((method) => method === 'thread/resume').length, 0);
});

test('新会话先持久化并关闭创建者，再通过官方队列启动首轮', async () => {
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
    queueThreadMessage: async (payload) => {
      calls.push(['queue', payload]);
      return { skipped: false, sessionId: payload.sessionId, queueMessageId: 'first-queue' };
    },
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
    historyMode: 'legacy',
    config: { shell_environment_policy: { inherit: 'all' }, model_reasoning_effort: 'high' },
  });
  assert.equal(calls.some(([method]) => method === 'turn/start'), false);
  assert.ok(calls.findIndex(([method]) => method === 'close') < calls.findIndex(([method]) => method === 'queue'));
  assert.deepEqual(calls.find(([method]) => method === 'thread/name/set')[1], { threadId: 'new-thread', name: 'Codex会话' });
  assert.equal(calls.find(([method]) => method === 'queue')[1].message, '新任务');
  assert.equal(result.queueMessageId, 'first-queue');
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

function successfulQueueChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  queueMicrotask(() => {
    child.stdout.end('Queued message queue-1 for thread thread-1.\n');
    child.emit('exit', 0, null);
  });
  return child;
}
