import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodexQueueRun } from '../../src/agent/codex/queue.js';
import type { AgentEvent } from '../../src/agent/types.js';

describe('CodexAdapter native queue mode', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('queues into an existing thread and returns the new turn without resuming the writer', async () => {
    const fake = await createQueueCodex();
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-run',
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: true,
      cwd: fake.dir,
      sandbox: 'workspace-write',
      prompt: 'continue from Feishu',
      threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-run',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-existing', cwd: fake.dir },
      { type: 'system', threadId: 'thread-existing', turnId: 'turn-queued' },
      { type: 'text', delta: 'queued response' },
      { type: 'done', threadId: 'thread-existing', terminationReason: 'normal' },
    ]);
  });

  it('updates the shared writer before queueing and reports actual model and effort', async () => {
    const fake = await createQueueCodex();
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-model-change', binary: fake.path, profileStateDir: fake.dir,
      inheritCodexHome: true, cwd: fake.dir, sandbox: 'workspace-write',
      prompt: 'use the selected model', threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-model-change',
      model: 'gpt-6-sol', reasoningEffort: 'high', remote: 'unix://',
    });
    const events = await collect(run.events);
    expect(events.filter((event) => event.type === 'system')).toEqual([
      { type: 'system', threadId: 'thread-existing', cwd: fake.dir },
      { type: 'system', threadId: 'thread-existing', model: 'gpt-6-sol', reasoningEffort: 'high' },
      { type: 'system', threadId: 'thread-existing', turnId: 'turn-queued' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(JSON.parse(await readFile(join(fake.dir, 'settings.json'), 'utf8'))).toEqual({
      threadId: 'thread-existing', model: 'gpt-6-sol', effort: 'high',
    });
  });

  it('does not queue when the writer rejects the selected model', async () => {
    const fake = await createQueueCodex();
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-invalid-model', binary: fake.path, profileStateDir: fake.dir,
      inheritCodexHome: true, cwd: fake.dir, sandbox: 'workspace-write',
      prompt: 'must not run with the old model', threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-invalid-model',
      model: 'unsupported-model', remote: 'unix://',
    });
    expect(await collect(run.events)).toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringContaining('model unavailable') }),
    ]);
    await expect(readFile(join(fake.dir, 'state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('loads a dormant thread only inside the shared daemon before updating settings', async () => {
    const fake = await createQueueCodex('completed', true);
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-dormant', binary: fake.path, profileStateDir: fake.dir,
      inheritCodexHome: true, cwd: fake.dir, sandbox: 'workspace-write',
      prompt: 'continue dormant thread', threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-dormant',
      model: 'gpt-6-sol', reasoningEffort: 'high', remote: 'unix://',
    });
    expect((await collect(run.events)).at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(await readFile(join(fake.dir, 'resumed.txt'), 'utf8')).toBe('proxy');
  });

  it('finishes an interrupted queued turn instead of polling forever', async () => {
    const fake = await createQueueCodex('interrupted');
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-interrupted',
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: true,
      cwd: fake.dir,
      sandbox: 'workspace-write',
      prompt: 'stop from Desktop',
      threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-interrupted',
      pollIntervalMs: 5,
      interruptedSettleMs: 15,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-existing', cwd: fake.dir },
      { type: 'system', threadId: 'thread-existing', turnId: 'turn-queued' },
      { type: 'text', delta: 'queued response' },
      { type: 'done', threadId: 'thread-existing', terminationReason: 'interrupted' },
    ]);
    await expect(run.waitForExit(0)).resolves.toBe(true);
  });

  it('keeps polling when an unfinished queued turn is provisionally interrupted', async () => {
    const fake = await createQueueCodex('provisional-interrupted');
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-provisional-interrupted',
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: true,
      cwd: fake.dir,
      sandbox: 'workspace-write',
      prompt: 'continue after transient status',
      threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-provisional-interrupted',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-existing', cwd: fake.dir },
      { type: 'system', threadId: 'thread-existing', turnId: 'turn-queued' },
      { type: 'text', delta: 'queued response' },
      { type: 'done', threadId: 'thread-existing', terminationReason: 'normal' },
    ]);
  });

  it('waits through a transient interrupted snapshot that already has a completion timestamp', async () => {
    const fake = await createQueueCodex('provisional-completed-interrupted');
    cleanup.push(fake.dir);
    const run = createCodexQueueRun({
      runId: 'queue-provisional-completed-interrupted',
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: true,
      cwd: fake.dir,
      sandbox: 'workspace-write',
      prompt: 'continue after stale terminal projection',
      threadId: 'thread-existing',
      clientUserMessageId: 'lark-channel-bridge:queue-provisional-completed-interrupted',
      pollIntervalMs: 5,
      interruptedSettleMs: 15,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-existing', cwd: fake.dir },
      { type: 'system', threadId: 'thread-existing', turnId: 'turn-queued' },
      { type: 'text', delta: 'queued response' },
      { type: 'done', threadId: 'thread-existing', terminationReason: 'normal' },
    ]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createQueueCodex(
  turnStatus: 'completed' | 'interrupted' | 'provisional-interrupted' |
    'provisional-completed-interrupted' = 'completed',
  startUnloaded = false,
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-queue-test-'));
  const statePath = join(dir, 'state.json');
  const scriptPath = join(dir, 'codex-fake.mjs');
  const path = process.platform === 'win32' ? join(dir, 'codex.cmd') : scriptPath;
  const script = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Duplex } from 'node:stream';
import WebSocket from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('ws')).href)};
const { WebSocketServer } = WebSocket;
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const rolloutPath = ${JSON.stringify(join(dir, 'rollout.jsonl'))};
const settingsPath = ${JSON.stringify(join(dir, 'settings.json'))};
let queuedReads = 0;
let terminalWritten = false;
if (args[0] === 'queue') {
  const prompt = args[args.indexOf('--message') + 1];
  writeFileSync(statePath, JSON.stringify({ prompt }));
  writeFileSync(rolloutPath, JSON.stringify({
    type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-queued' }
  }) + '\\n');
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    appendFileSync(rolloutPath, JSON.stringify({
      type: 'turn_context', payload: { turn_id: 'turn-queued', model: settings.model, effort: settings.effort }
    }) + '\\n');
  }
  console.log('Queued message queue-1 for thread thread-existing.');
  process.exit(0);
}
if (args[0] !== 'app-server') process.exit(3);
let socket;
let loaded = ${JSON.stringify(!startUnloaded)};
const send = value => socket ? socket.send(JSON.stringify(value)) : console.log(JSON.stringify(value));
function handle(req) {
  if (req.method === 'initialize') {
    send({ id: req.id, result: { userAgent: 'fake' } });
    return;
  }
  if (req.method === 'thread/settings/update') {
    if (args[1] !== 'proxy') process.exit(5);
    if (!loaded) {
      send({ id: req.id, error: { code: -32600, message: 'thread not found: thread-existing' } });
      return;
    }
    if (req.params.model === 'unsupported-model') {
      send({ id: req.id, error: { code: -32600, message: 'model unavailable' } });
      return;
    }
    writeFileSync(settingsPath, JSON.stringify(req.params));
    send({ id: req.id, result: {} });
    return;
  }
  if (req.method === 'thread/resume') {
    if (args[1] !== 'proxy') process.exit(6);
    loaded = true;
    writeFileSync(${JSON.stringify(join(dir, 'resumed.txt'))}, args[1]);
    send({ id: req.id, result: {} });
    return;
  }
  if (req.method !== 'thread/read') return;
  const queued = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : undefined;
  if (queued) queuedReads += 1;
  const configuredStatus = ${JSON.stringify(turnStatus)};
  const transientInterrupted = configuredStatus === 'provisional-interrupted';
  const status = configuredStatus === 'provisional-completed-interrupted'
    ? 'interrupted'
    : transientInterrupted && queuedReads === 1
      ? 'interrupted'
      : transientInterrupted
      ? 'completed'
      : configuredStatus;
  if (queued && !terminalWritten && (
    status === 'completed' || configuredStatus === 'provisional-completed-interrupted'
  )) {
    appendFileSync(rolloutPath, JSON.stringify({
      type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-queued' }
    }) + '\\n');
    terminalWritten = true;
  } else if (queued && !terminalWritten && status === 'interrupted' && !transientInterrupted) {
    appendFileSync(rolloutPath, JSON.stringify({
      type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-queued' }
    }) + '\\n');
    terminalWritten = true;
  }
  const includeAgentMessage = configuredStatus !== 'provisional-completed-interrupted' ||
    queuedReads > 1;
  const turns = queued ? [{
    id: 'turn-queued',
    status,
    completedAt: status === 'interrupted' && configuredStatus === 'provisional-interrupted'
        ? null
        : Date.now() / 1000,
    error: null,
    items: [
      { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: queued.prompt }] },
      ...(includeAgentMessage
        ? [{ type: 'agentMessage', id: 'agent-1', text: 'queued response', phase: 'final_answer' }]
        : [])
    ]
  }] : [];
  send({
    id: req.id,
    result: { thread: {
      id: 'thread-existing', path: rolloutPath, updatedAt: Date.now() / 1000, turns
    } }
  });
}
if (args[1] === 'proxy') {
  const stream = Duplex.from({ readable: process.stdin, writable: process.stdout });
  const server = new WebSocketServer({ noServer: true });
  let handshake = Buffer.alloc(0);
  const upgrade = chunk => {
    handshake = Buffer.concat([handshake, chunk]);
    const end = handshake.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    stream.removeListener('data', upgrade);
    const lines = handshake.subarray(0, end).toString().split('\\r\\n');
    const headers = Object.fromEntries(lines.slice(1).map(line => {
      const index = line.indexOf(':');
      return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
    }));
    server.handleUpgrade({ method: 'GET', url: '/', headers }, stream, handshake.subarray(end + 4), ws => {
      socket = ws;
      socket.on('message', data => handle(JSON.parse(data.toString())));
    });
  };
  stream.on('data', upgrade);
} else {
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => handle(JSON.parse(line)));
}
`;
  await writeFile(scriptPath, script, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await chmod(path, 0o755);
  }
  return { dir, path };
}
