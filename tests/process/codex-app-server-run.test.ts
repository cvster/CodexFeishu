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

  it('keeps a blocking request pending and responds on the original RPC connection', async () => {
    const fake = await createFakeAppServer(true);
    cleanup.push(fake.dir);
    const run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir,
      inheritCodexHome: true, stopGraceMs: 50 }).run({ runId: 'interactive', cwd: fake.dir, prompt: 'choose' });
    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'user_input') {
        await new Promise((resolve) => setTimeout(resolve, 30));
        const before = JSON.parse(await readFile(fake.recordPath, 'utf8'));
        expect(before.some((r: { result?: unknown }) => r.result)).toBe(false);
        expect(event.prompt.request.isBlocking).toBe(true);
        expect(await event.prompt.respond({ q: { answers: ['A'] } })).toBe(true);
        expect(await event.prompt.respond({ q: { answers: ['B'] } })).toBe(false);
      }
    }
    expect(events.some((event) => event.type === 'user_input_resolved')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    const requests = JSON.parse(await readFile(fake.recordPath, 'utf8'));
    expect(requests.filter((r: { result?: unknown }) => r.result)).toEqual([{ id: 1, result: { answers: { q: { answers: ['A'] } } } }]);
    expect(await run.waitForExit(2000)).toBe(true);
  });
  it('answers a fresh async question through its existing stdio writer and waits for steer acknowledgement', async () => {
    const fake = await createFakeAppServer('async'); cleanup.push(fake.dir);
    const run = new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir,
      inheritCodexHome: true, stopGraceMs: 50 }).run({ runId: 'async', cwd: fake.dir, prompt: 'choose' });
    let questions = 0;
    for await (const event of run.events) {
      if (event.type !== 'user_input') continue;
      questions++;
      expect(event.prompt.request.kind).toBe('async');
      expect(event.prompt.request.isBlocking).toBe(false);
      const id = event.prompt.request.questions[0]!.id;
      expect(await event.prompt.respond({ [id]: { answers: ['B'] } })).toBe(true);
      expect(await event.prompt.respond({ [id]: { answers: ['A'] } })).toBe(false);
    }
    expect(questions).toBe(1);
    const requests = JSON.parse(await readFile(fake.recordPath, 'utf8'));
    expect(requests.filter((r: { method: string }) => r.method === 'turn/steer')).toEqual([
      expect.objectContaining({ params: { threadId: 'thread-visible', expectedTurnId: 'turn-1',
        clientUserMessageId: expect.stringMatching(/^lark-channel-bridge:async:/), input: [
        { type: 'text', text: expect.stringContaining('"answer":"B"'), text_elements: [] },
      ] } }),
    ]);
    expect(requests.some((r: { method: string }) => ['thread/resume', 'thread/queue/add'].includes(r.method))).toBe(false);
    expect(await run.waitForExit(2000)).toBe(true);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeAppServer(interactive: boolean | 'async' = false): Promise<{
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
  if (${interactive === true} && request.id === 1 && request.result) {
    send({ method: 'serverRequest/resolved', params: { threadId: 'thread-visible', requestId: 1 } });
    send({ method: 'turn/completed', params: { threadId: 'thread-visible', turn: { id: 'turn-1', status: 'completed' } } });
    return;
  }
  if (${interactive === 'async'} && request.method === 'turn/steer') {
    send({ id: request.id, result: { turnId: 'turn-1' } });
    send({ method: 'turn/completed', params: { threadId: 'thread-visible', turn: { id: 'turn-1', status: 'completed' } } });
    return;
  }
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
  if (${interactive === 'async'}) {
    const item = { type: 'agentMessage', id: 'async-question', delivery: 'async', text: 'Choose: A or B',
      questions: [{ title: 'Choose', options: ['A', 'B'] }] };
    send({ method: 'item/completed', params: { threadId: 'thread-visible', turnId: 'turn-1', item } });
    send({ method: 'item/completed', params: { threadId: 'thread-visible', turnId: 'turn-1', item } });
    return;
  }
  if (${interactive === true}) {
    // Server request ID intentionally collides with client's initialize ID.
    send({ id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread-visible', turnId: 'turn-1', itemId: 'input-1', isBlocking: true,
      questions: [{ id: 'q', header: 'Choose', question: 'A or B?', isOther: false, isSecret: false, options: [{ label: 'A', description: 'one' }, { label: 'B', description: 'two' }] }] } });
    return;
  }
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
