import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      { type: 'text', delta: 'queued response' },
      { type: 'done', threadId: 'thread-existing', terminationReason: 'normal' },
    ]);
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
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-queue-test-'));
  const statePath = join(dir, 'state.json');
  const scriptPath = join(dir, 'codex-fake.mjs');
  const path = process.platform === 'win32' ? join(dir, 'codex.cmd') : scriptPath;
  const script = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const rolloutPath = ${JSON.stringify(join(dir, 'rollout.jsonl'))};
let queuedReads = 0;
let terminalWritten = false;
if (args[0] === 'queue') {
  const prompt = args[args.indexOf('--message') + 1];
  writeFileSync(statePath, JSON.stringify({ prompt }));
  writeFileSync(rolloutPath, JSON.stringify({
    type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-queued' }
  }) + '\\n');
  console.log('Queued message queue-1 for thread thread-existing.');
  process.exit(0);
}
if (args[0] !== 'app-server') process.exit(3);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    console.log(JSON.stringify({ id: req.id, result: { userAgent: 'fake' } }));
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
  console.log(JSON.stringify({
    id: req.id,
    result: { thread: {
      id: 'thread-existing', path: rolloutPath, updatedAt: Date.now() / 1000, turns
    } }
  }));
});
`;
  await writeFile(scriptPath, script, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await chmod(path, 0o755);
  }
  return { dir, path };
}
