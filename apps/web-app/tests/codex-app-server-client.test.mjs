import assert from 'node:assert/strict';
import test from 'node:test';

import {
  archiveCodexAppThread,
} from '../upstream-overrides/claudecodeui-1.25.2/server/codex-app-server-client.mjs';

function createArchiveClient(archiveError) {
  return {
    notify() {},
    async close() {},
    async request(method) {
      if (method === 'initialize') return {};
      if (method === 'thread/archive') throw archiveError;
      throw new Error(`Unexpected request: ${method}`);
    },
  };
}

test('writer 被 App 占用时使用状态库完成归档', async () => {
  const calls = [];
  const result = await archiveCodexAppThread(
    { sessionId: 'thread-1', projectPath: 'D:/project' },
    {
      createClient: () => createArchiveClient(new Error('thread thread-1 already has an active writer')),
      archiveInStateStore: async (payload) => {
        calls.push(payload);
        return { skipped: false, sessionId: payload.sessionId, fallback: 'state-store' };
      },
    },
  );

  assert.deepEqual(calls, [{ sessionId: 'thread-1', projectPath: 'D:/project' }]);
  assert.equal(result.fallback, 'state-store');
});

test('非 writer 冲突的原生归档错误不会被掩盖', async () => {
  await assert.rejects(
    archiveCodexAppThread(
      { sessionId: 'thread-2', projectPath: 'D:/project' },
      {
        createClient: () => createArchiveClient(new Error('permission denied')),
        archiveInStateStore: async () => {
          throw new Error('fallback should not run');
        },
      },
    ),
    /permission denied/,
  );
});
