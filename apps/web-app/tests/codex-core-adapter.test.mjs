import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCodexAppServerClient, archiveCodexAppThread } from '../upstream-overrides/claudecodeui-1.25.2/server/codex-app-server-client.mjs';
import { CODEX_MODELS, CODEX_REASONING_EFFORTS } from '../upstream-overrides/claudecodeui-1.25.2/shared/modelConstants.js';
import { reconcileCodexThreadSnapshot, isCodexSnapshotActive } from '../upstream-overrides/claudecodeui-1.25.2/server/codex-core/index.js';

test('web uses shared handshake and closing its observer does not cancel work', async () => {
  const requests = [];
  let child;
  const client = createCodexAppServerClient({ cliPath: 'fake-cli', spawnImpl: () => {
    child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('close')); return true; };
    child.stdin.on('data', (data) => {
      const request = JSON.parse(data.toString()); requests.push(request);
      if (request.id !== undefined) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'));
    });
    return child;
  } });
  await client.request('initialize'); client.notify('initialized');
  await client.request('model/list');
  const notification = client.waitForNotification('turn/completed', (p) => p.threadId === 'thread', 1000);
  child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread' } }) + '\n');
  assert.equal((await notification).threadId, 'thread');
  await client.close();
  assert.deepEqual(requests.map((r) => r.method), ['initialize', 'initialized', 'model/list']);
  await assert.rejects(client.waitForNotification('turn/completed'), /stopped/);
});

test('web model picker preserves its defaults and uses the shared new-model catalog', () => {
  assert.equal(CODEX_MODELS.OPTIONS[0].value, 'gpt-6.1-sol');
  assert.equal(CODEX_MODELS.DEFAULT, 'gpt-5.6-sol');
  assert.equal(CODEX_REASONING_EFFORTS.DEFAULT, 'medium');
});

test('both adapters defer projected interruption and refresh durable completion', async () => {
  const snapshot = { id: 'thread', turns: [{ id: 'turn', status: 'interrupted', items: [] }] };
  const waiting = await reconcileCodexThreadSnapshot({ persistedTurnTerminal: async () => undefined, readThread: async () => snapshot }, snapshot);
  assert.equal(isCodexSnapshotActive(waiting), true);
  const final = await reconcileCodexThreadSnapshot({ persistedTurnTerminal: async () => 'completed', readThread: async () => ({ ...snapshot, turns: [{ ...snapshot.turns[0], items: [{ type: 'agentMessage', text: 'final output' }] }] }) }, snapshot);
  assert.equal(isCodexSnapshotActive(final), false);
  assert.equal(final.turns[0].status, 'completed');
  assert.equal(final.turns[0].items[0].text, 'final output');
});

test('web archive prefers the discovered shared public endpoint', async () => {
  let options;
  const requests = [];
  await archiveCodexAppThread({ sessionId: 'thread' }, {
    resolveEndpoint: async () => 'unix:///test/control.sock',
    createClient: (value) => { options = value; return {
      request: async (method) => { requests.push(method); return {}; },
      notify() {}, async close() {},
    }; },
  });
  assert.equal(options.sharedServer, true);
  assert.equal(options.remote, 'unix:///test/control.sock');
  assert.deepEqual(requests, ['initialize', 'thread/archive']);
});
