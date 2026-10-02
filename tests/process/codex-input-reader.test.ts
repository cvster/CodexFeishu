import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { CodexThreadReader } from '../../src/session/codex-thread-reader';
import type { CodexInputPrompt } from '../../src/session/codex-user-input';

describe('shared Codex interactive observer', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of closers.splice(0)) await close(); });
  async function setup(status = 'active', steerResponse: object | null = { result: { turnId: 'turn' } }) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const received: Array<Record<string, unknown>> = [];
    const prompts: CodexInputPrompt[] = [];
    const notifications = vi.fn();
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()); received.push(message);
        const send = (value: object) => socket.send(JSON.stringify(value));
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        if (message.method === 'turn/steer') {
          if (steerResponse === null) socket.close();
          else send({ id: message.id, ...steerResponse });
        }
        if (message.method === 'thread/read') send({ id: message.id, result: { thread: {
          id: 'thread', status: { type: status, activeFlags: ['waitingOnUserInput'] }, turns: [],
        } } });
        if (message.method === 'thread/resume') {
          send({ id: message.id, result: { thread: { id: 'thread' } } });
          send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread' } });
          send({ id: 'elicitation', method: 'mcpServer/elicitation/request', params: { threadId: 'thread' } });
          send({ id: 'question', method: 'item/tool/requestUserInput', params: {
            threadId: 'thread', turnId: 'turn', itemId: 'input', isBlocking: false,
            questions: [{ id: 'q', header: 'Pick', question: 'Choose', isOther: true, isSecret: false, options: null }],
          } });
        }
        if (message.id === 'question' && message.result) send({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'question' } });
      });
    });
    const reader = new CodexThreadReader({ binary: 'unused', profileStateDir: '.', inheritCodexHome: true,
      sharedServer: true, passive: true, remote: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      onUserInput: (prompt) => prompts.push(prompt), onNotification: notifications });
    closers.push(async () => { await reader.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    return { reader, received, prompts, notifications };
  }
  it('joins only the shared active thread without configuration overrides and receives replay', async () => {
    const { reader, received, prompts, notifications } = await setup();
    expect(await reader.watchLoadedThread('thread')).toBe(true);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(await reader.watchLoadedThread('thread')).toBe(true);
    expect(received.filter((r) => r.method === 'thread/resume')).toEqual([
      expect.objectContaining({ params: { threadId: 'thread', excludeTurns: true } }),
    ]);
    expect(received.some((r) => r.id === 'approval' || r.id === 'elicitation')).toBe(false);
    expect(await prompts[0]!.respond({ q: { answers: ['custom'] } })).toBe(true);
    await vi.waitFor(() => expect(notifications).toHaveBeenCalledWith('serverRequest/resolved', { threadId: 'thread', requestId: 'question' }));
    expect(await prompts[0]!.respond({ q: { answers: ['duplicate'] } })).toBe(false);
    expect(received.filter((r) => r.id === 'question')).toEqual([{ id: 'question', result: { answers: { q: { answers: ['custom'] } } } }]);
  });
  it.each(['idle', 'notLoaded'])('never wakes a %s thread', async (status) => {
    const { reader, received } = await setup(status);
    expect(await reader.watchLoadedThread('thread')).toBe(false);
    expect(received.some((r) => r.method === 'thread/resume')).toBe(false);
  });
  it('invalidates reply callbacks after connection loss', async () => {
    const { reader, prompts } = await setup();
    await reader.watchLoadedThread('thread');
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    await reader.stop();
    expect(await prompts[0]!.respond({ q: { answers: ['stale'] } })).toBe(false);
  });
  it('never subscribes through an independent embedded server', async () => {
    const reader = new CodexThreadReader({ binary: 'unused', profileStateDir: '.' });
    await expect(reader.watchLoadedThread('thread')).rejects.toThrow('writer daemon');
    await reader.stop();
  });
  it('uses public turn/steer with expectedTurnId and no resume/queue/start fallback', async () => {
    const { reader, received } = await setup();
    await reader.steerTurn('thread', 'turn', 'structured answer');
    expect(received.filter((r) => r.method === 'turn/steer')).toEqual([expect.objectContaining({ params: {
      threadId: 'thread', expectedTurnId: 'turn', input: [{ type: 'text', text: 'structured answer', text_elements: [] }],
      clientUserMessageId: expect.stringMatching(/^lark-channel-bridge:async:/),
    } })]);
    expect(received.some((r) => ['thread/resume', 'thread/queue/add', 'turn/start'].includes(String(r.method)))).toBe(false);
  });
  it('propagates a stale-turn rejection without queuing', async () => {
    const { reader, received } = await setup('active', { error: { code: -32600, message: 'no active turn to steer' } });
    await expect(reader.steerTurn('thread', 'turn', 'answer')).rejects.toThrow('no active turn');
    expect(received.some((r) => String(r.method).includes('queue'))).toBe(false);
  });
  it('requires a matching acknowledgement and refuses a competing embedded writer', async () => {
    const { reader } = await setup('active', { result: { turnId: 'wrong-turn' } });
    await expect(reader.steerTurn('thread', 'turn', 'answer')).rejects.toThrow('尚未确认');
    const embedded = new CodexThreadReader({ binary: 'unused', profileStateDir: '.' });
    await expect(embedded.steerTurn('thread', 'turn', 'answer')).rejects.toThrow('writer app-server');
    await embedded.stop();
  });
  it('treats a lost connection after steer as unconfirmed, not as a safe automatic retry', async () => {
    const { reader, received } = await setup('active', null);
    await expect(reader.steerTurn('thread', 'turn', 'answer')).rejects.toThrow('尚未确认');
    expect(received.filter((r) => r.method === 'turn/steer')).toHaveLength(1);
    expect(received.some((r) => ['thread/resume', 'thread/queue/add', 'turn/start'].includes(String(r.method)))).toBe(false);
  });
});
