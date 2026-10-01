import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

describe('Codex app-server fresh thread run', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
    );
  });

  it('creates a paginated Desktop-compatible thread and streams its first turn', async () => {
    const fake = await createFakeAppServer();
    cleanup.push(fake.dir);
    const image = join(fake.dir, 'image.png');

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: true,
      sandbox: 'danger-full-access',
      stopGraceMs: 50,
    }).run({
      runId: 'run-app-server',
      cwd: fake.dir,
      prompt: 'hello',
      images: [image],
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });

    expect(await collect(run.events)).toEqual([
      {
        type: 'system',
        threadId: 'thread-visible',
        cwd: fake.dir,
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
      },
      { type: 'system', threadId: 'thread-visible', turnId: 'turn-1' },
      {
        type: 'tool_use',
        id: 'command-1',
        name: 'command_execution',
        input: { command: 'git status --short' },
      },
      {
        type: 'tool_result',
        id: 'command-1',
        output: 'clean',
        isError: false,
      },
      { type: 'text', delta: 'hello from app-server' },
      {
        type: 'usage',
        inputTokens: 12,
        outputTokens: 4,
        cachedInputTokens: 3,
        reasoningOutputTokens: 1,
      },
      { type: 'done', threadId: 'thread-visible', terminationReason: 'normal' },
    ]);
    expect(await run.waitForExit(2_000)).toBe(true);

    const requests = JSON.parse(await readFile(fake.recordPath, 'utf8')) as Array<{
      method: string;
      params?: Record<string, unknown>;
    }>;
    expect(requests.map((request) => request.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
    ]);
    expect(requests[0]?.params).toMatchObject({
      clientInfo: { name: 'lark-channel-bridge' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    expect(requests[2]?.params).toMatchObject({
      cwd: fake.dir,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      historyMode: 'paginated',
      threadSource: 'lark-channel-bridge',
      model: 'gpt-5.6-sol',
      developerInstructions: expect.stringContaining('lark-channel-bridge'),
    });
    expect(requests[3]?.params).toMatchObject({
      threadId: 'thread-visible',
      effort: 'high',
      clientUserMessageId: 'lark-channel-bridge:run-app-server',
      input: [
        { type: 'text', text: 'hello', text_elements: [] },
        { type: 'localImage', path: image },
      ],
    });
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeAppServer(): Promise<{
  dir: string;
  path: string;
  recordPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-run-'));
  const recordPath = join(dir, 'requests.json');
  const scriptPath = join(dir, 'fake-app-server.mjs');
  const path = process.platform === 'win32' ? join(dir, 'codex.cmd') : scriptPath;
  const script = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const recordPath = ${JSON.stringify(recordPath)};
const requests = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const save = () => writeFileSync(recordPath, JSON.stringify(requests));
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  requests.push(request);
  save();
  if (request.method === 'initialize') {
    send({ id: request.id, result: { userAgent: 'fake', codexHome: '.', platformFamily: 'test', platformOs: 'test' } });
    return;
  }
  if (request.method === 'thread/start') {
    send({ id: request.id, result: { thread: { id: 'thread-visible' } } });
    return;
  }
  if (request.method !== 'turn/start') return;
  send({ id: request.id, result: { turn: { id: 'turn-1' } } });
  send({ method: 'turn/started', params: { threadId: 'thread-visible', turn: { id: 'turn-1', status: 'inProgress' } } });
  send({ method: 'item/started', params: { threadId: 'thread-visible', turnId: 'turn-1', item: { type: 'commandExecution', id: 'command-1', command: 'git status --short' } } });
  send({ method: 'item/completed', params: { threadId: 'thread-visible', turnId: 'turn-1', item: { type: 'commandExecution', id: 'command-1', aggregatedOutput: 'clean', exitCode: 0 } } });
  send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-visible', turnId: 'turn-1', itemId: 'message-1', delta: 'hello from app-server' } });
  send({ method: 'item/completed', params: { threadId: 'thread-visible', turnId: 'turn-1', item: { type: 'agentMessage', id: 'message-1', text: 'hello from app-server' } } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-visible', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3, reasoningOutputTokens: 1 } } } });
  send({ method: 'turn/completed', params: { threadId: 'thread-visible', turn: { id: 'turn-1', status: 'completed', error: null } } });
});
`;
  await writeFile(scriptPath, script, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await chmod(path, 0o755);
  }
  return { dir, path, recordPath };
}
