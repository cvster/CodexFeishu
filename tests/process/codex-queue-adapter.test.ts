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

async function createQueueCodex(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-queue-test-'));
  const statePath = join(dir, 'state.json');
  const scriptPath = join(dir, 'codex-fake.mjs');
  const path = process.platform === 'win32' ? join(dir, 'codex.cmd') : scriptPath;
  const script = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
if (args[0] === 'queue') {
  const prompt = args[args.indexOf('--message') + 1];
  writeFileSync(statePath, JSON.stringify({ prompt }));
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
  const turns = queued ? [{
    id: 'turn-queued',
    status: 'completed',
    error: null,
    items: [
      { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: queued.prompt }] },
      { type: 'agentMessage', id: 'agent-1', text: 'queued response', phase: 'final_answer' }
    ]
  }] : [];
  console.log(JSON.stringify({ id: req.id, result: { thread: { id: 'thread-existing', turns } } }));
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
