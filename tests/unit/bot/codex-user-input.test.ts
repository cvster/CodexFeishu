import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { startCodexUserInput, type CodexInputHandle } from '../../../src/bot/codex-user-input';
import type { CodexInputPrompt } from '../../../src/session/codex-user-input';
import type { SessionCatalog } from '../../../src/session/catalog';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createFakeChannel } from '../../helpers/fake-channel';
import type { CodexThreadSnapshot } from '../../../src/session/codex-thread-reader';
import { CodexAsyncAnswerUnconfirmedError, parseCodexAsyncInput, serializeCodexAsyncAnswers } from '../../../src/session/codex-async-input';

describe('Codex user input lifecycle', () => {
  const handles: CodexInputHandle[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.stop()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function setup(dir?: string, liveStatus = 'notLoaded', writer?: {
    readThread: (id: string) => Promise<CodexThreadSnapshot>;
    steerTurn: (threadId: string, turnId: string, text: string) => Promise<void>;
  }) {
    dir ??= await mkdtemp(join(tmpdir(), 'codex-input-'));
    if (!dirs.includes(dir)) dirs.push(dir);
    const channel = createFakeChannel();
    const profileConfig = createDefaultProfileConfig({ agentKind: 'codex',
      accounts: { app: { id: 'cli_ours', secret: 'test', tenant: 'feishu' } }, codex: { binaryPath: 'fake' } });
    const controls = { profileConfig, codexReplySync: { runNow: vi.fn(async () => {}) } } as unknown as Controls;
    const entries = [{ status: 'active', agentId: 'codex', threadId: 'thread', scopeId: 'oc_group', botAppId: 'cli_ours' },
      { status: 'active', agentId: 'codex', threadId: 'thread', scopeId: 'oc_other', botAppId: 'cli_other' }];
    const handle = await startCodexUserInput({ channel: channel as unknown as LarkChannel, controls,
      sessionCatalog: { entries: () => entries } as unknown as SessionCatalog, profileStateDir: dir, intervalMs: 60_000,
      readerFactory: () => ({ watchLoadedThread: vi.fn(async () => false), stop: vi.fn(async () => {}),
        readThreadStatus: vi.fn(async () => ({ type: liveStatus, activeFlags: [] })), ...writer }) });
    handles.push(handle);
    return { handle, channel, dir };
  }
  const prompt = (): CodexInputPrompt => ({ requestId: 7, request: {
    threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true,
    questions: [{ id: 'q', header: '选择', question: '用哪个？', isOther: true, isSecret: false,
      options: [{ label: '选项 A', description: '推荐' }, { label: '选项 B', description: '兼容' }] }],
  }, respond: vi.fn(async () => true) });
  async function delivery(dir: string) {
    let result: { token: string; messageId: string; sequence: number } | undefined;
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(join(dir, 'codex-user-input.json'), 'utf8'));
      result = saved.entries[0]?.[1]?.deliveries[0];
      expect(result).toBeDefined();
    });
    return result!;
  }
  it('deduplicates replay and answers the original request once without a chat turn', async () => {
    const { handle, channel, dir } = await setup();
    const p = prompt();
    handle.accept(p, 'run');
    const d = await delivery(dir);
    handle.accept(p, 'run');
    expect(handle.isWaiting('thread', 'turn')).toBe(true);
    expect(channel.sent).toHaveLength(1);
    const first = handle.handleAction('oc_group', d.messageId, d.token, { q_0: '1' });
    await expect(handle.handleAction('oc_group', d.messageId, d.token, { q_0: '0' })).rejects.toThrow('已回答');
    await first;
    expect(p.respond).toHaveBeenCalledTimes(1);
    expect(p.respond).toHaveBeenCalledWith({ q: { answers: ['选项 B'] } });
    expect(channel.sent).toHaveLength(1);
    expect(handle.isWaiting('thread', 'turn')).toBe(false);
    await handle.stop(); handles.splice(handles.indexOf(handle), 1);
    expect(await readFile(join(dir, 'codex-user-input.json'), 'utf8')).not.toContain('选项 B"\n');
    expect(JSON.stringify(channel.rawClient.requests.at(-1))).not.toContain('__codex_input');
  });
  it('rejects foreign scope, foreign card and invalid form without consuming the request', async () => {
    const { handle, dir } = await setup(); const p = prompt(); handle.accept(p, 'run');
    const d = await delivery(dir);
    await expect(handle.handleAction('oc_other', d.messageId, d.token, { q_0: '0' })).rejects.toThrow('不属于');
    await expect(handle.handleAction('oc_group', 'other_card', d.token, { q_0: '0' })).rejects.toThrow('不属于');
    await expect(handle.handleAction('oc_group', d.messageId, d.token, {})).rejects.toThrow('第 1');
    expect(p.respond).not.toHaveBeenCalled();
    expect(handle.isWaiting('thread', 'turn')).toBe(true);
  });
  it('disables a request answered on desktop or ended with the turn', async () => {
    const { handle, dir } = await setup(); const p = prompt(); handle.accept(p, 'shared');
    const d = await delivery(dir);
    handle.resolve('thread', 7, 'unrelated_connection');
    expect(handle.isWaiting('thread', 'turn')).toBe(true);
    handle.resolve('thread', 7, 'shared');
    await expect(handle.handleAction('oc_group', d.messageId, d.token, { q_0: '0' })).rejects.toThrow('已回答');
    expect(p.respond).not.toHaveBeenCalled();
    const second = { ...p, requestId: 8, request: { ...p.request, itemId: 'second' } };
    handle.accept(second, 'run');
    handle.endTurn('thread', 'turn');
    expect(handle.isWaiting('thread', 'turn')).toBe(false);
  });
  it('reuses persisted card identity after reconnect and never persists typed answers', async () => {
    const one = await setup(); const p = prompt(); one.handle.accept(p, 'shared');
    const before = await delivery(one.dir);
    await one.handle.stop(); handles.splice(handles.indexOf(one.handle), 1);
    const two = await setup(one.dir);
    await expect(two.handle.handleAction('oc_group', before.messageId, before.token, { q_0: '0' })).rejects.toThrow('重连');
    const replay = prompt(); two.handle.accept(replay, 'shared');
    await two.handle.handleAction('oc_group', before.messageId, before.token, { custom_0: 'PRIVATE_CUSTOM_ANSWER' });
    await two.handle.stop(); handles.splice(handles.indexOf(two.handle), 1);
    expect(two.channel.sent).toHaveLength(0);
    const saved = await readFile(join(one.dir, 'codex-user-input.json'), 'utf8');
    expect(saved).not.toContain('PRIVATE_CUSTOM_ANSWER');
    expect(saved).toContain(before.messageId);
  });
  it('does not treat nonblocking questions as a hung task', async () => {
    const { handle, dir } = await setup(); const p = prompt(); p.request.isBlocking = false;
    handle.accept(p, 'run'); await delivery(dir);
    expect(handle.isWaiting('thread', 'turn')).toBe(false);
  });
  it('closes a card if desktop answers while the initial send is in flight', async () => {
    const { handle, channel, dir } = await setup(); const p = prompt();
    const original = channel.send.bind(channel);
    vi.spyOn(channel, 'send').mockImplementation(async (...args) => {
      handle.resolve('thread', p.requestId, 'shared');
      return original(...args);
    });
    handle.accept(p, 'shared');
    await delivery(dir);
    await handle.stop(); handles.splice(handles.indexOf(handle), 1);
    expect(JSON.stringify(channel.rawClient.requests.at(-1))).toContain('问题已结束');
    expect(JSON.stringify(channel.rawClient.requests.at(-1))).not.toContain('__codex_input');
  });
  it('closes an offline orphan using live idle status, not a history projection', async () => {
    const one = await setup(); const p = prompt(); one.handle.accept(p, 'shared');
    const d = await delivery(one.dir);
    await one.handle.stop(); handles.splice(handles.indexOf(one.handle), 1);
    const two = await setup(one.dir, 'idle');
    await vi.waitFor(() => expect(two.handle.isWaiting('thread', 'turn')).toBe(false));
    await expect(two.handle.handleAction('oc_group', d.messageId, d.token, { q_0: '0' })).rejects.toThrow('已回答');
    expect(p.respond).not.toHaveBeenCalled();
  });

  const asyncItem = { type: 'agentMessage', id: 'async-item', delivery: 'async',
    questions: [{ title: '继续哪个方案？', options: ['A', 'B'] }], text: '继续哪个方案？' };
  const asyncSnapshot = (): CodexThreadSnapshot => ({ id: 'thread', turns: [{ id: 'turn', status: 'inProgress', items: [asyncItem] }] });
  it('delivers async questions once and steers the exact live turn, not a queued turn', async () => {
    let snapshot = asyncSnapshot();
    const steerTurn = vi.fn(async () => {});
    const { handle, channel, dir } = await setup(undefined, 'active', { readThread: async () => snapshot, steerTurn });
    handle.observeSnapshot(snapshot); const d = await delivery(dir);
    handle.observeSnapshot(snapshot);
    expect(channel.sent).toHaveLength(1);
    expect(handle.isWaiting('thread', 'turn')).toBe(false);
    await handle.handleAction('oc_group', d.messageId, d.token, { q_0: '1' });
    expect(steerTurn).toHaveBeenCalledTimes(1);
    expect(steerTurn).toHaveBeenCalledWith('thread', 'turn', expect.stringContaining('"answer":"B"'));
    handle.observeSnapshot(snapshot);
    await expect(handle.handleAction('oc_group', d.messageId, d.token, { q_0: '0' })).rejects.toThrow('已回答');
    expect(steerTurn).toHaveBeenCalledTimes(1);
  });
  it('closes forms answered on Desktop and never replays ended/history questions', async () => {
    const snapshot = asyncSnapshot(); const { handle, channel, dir } = await setup();
    handle.observeSnapshot(snapshot); const d = await delivery(dir);
    const request = parseCodexAsyncInput('thread', 'turn', asyncItem)!;
    snapshot.turns[0]!.items.push({ type: 'userMessage', content: [{ type: 'text',
      text: serializeCodexAsyncAnswers(request, { [request.questions[0]!.id]: { answers: ['A'] } }) }] });
    handle.observeSnapshot(snapshot);
    await expect(handle.handleAction('oc_group', d.messageId, d.token, { q_0: '1' })).rejects.toThrow('已回答');
    handle.observeSnapshot({ id: 'thread', turns: [{ id: 'old', status: 'completed', items: [asyncItem] }] });
    expect(channel.sent).toHaveLength(1);
  });
  it('checks live status again before submission and rejects stale turn and Desktop answer races', async () => {
    let live = asyncSnapshot(); const steerTurn = vi.fn(async () => {});
    const { handle, dir } = await setup(undefined, 'active', { readThread: async () => live, steerTurn });
    handle.observeSnapshot(live); const d = await delivery(dir);
    live = { id: 'thread', turns: [{ id: 'next', status: 'inProgress', items: [] }] };
    await handle.handleAction('oc_group', d.messageId, d.token, { q_0: '0' });
    expect(steerTurn).not.toHaveBeenCalled();
  });
  it('reports unavailable public writer, keeps card identity on retry and never silently queues', async () => {
    const writer = { readThread: vi.fn(async () => { throw new Error('no endpoint'); }), steerTurn: vi.fn(async () => {}) };
    const { handle, channel, dir } = await setup(undefined, 'active', writer);
    const snapshot = asyncSnapshot(); handle.observeSnapshot(snapshot); const d = await delivery(dir);
    await expect(handle.handleAction('oc_group', d.messageId, d.token, { q_0: '0' })).rejects.toThrow('公开 app-server');
    handle.observeSnapshot(snapshot);
    expect(channel.sent).toHaveLength(1);
    expect(writer.steerTurn).not.toHaveBeenCalled();
  });
  it('does not auto-resubmit an async answer after lost acknowledgement or restart', async () => {
    const writer = { readThread: async () => asyncSnapshot(), steerTurn: vi.fn(async () => { throw new CodexAsyncAnswerUnconfirmedError(); }) };
    const one = await setup(undefined, 'active', writer);
    one.handle.observeSnapshot(asyncSnapshot()); const d = await delivery(one.dir);
    await expect(one.handle.handleAction('oc_group', d.messageId, d.token, { q_0: '0' })).rejects.toThrow('尚未确认');
    one.handle.observeSnapshot(asyncSnapshot());
    await expect(one.handle.handleAction('oc_group', d.messageId, d.token, { q_0: '0' })).rejects.toThrow('已回答');
    await one.handle.stop(); handles.splice(handles.indexOf(one.handle), 1);
    const two = await setup(one.dir, 'active', writer); two.handle.observeSnapshot(asyncSnapshot());
    await expect(two.handle.handleAction('oc_group', d.messageId, d.token, { q_0: '0' })).rejects.toThrow('已回答');
    expect(two.channel.sent).toHaveLength(0);
    expect(writer.steerTurn).toHaveBeenCalledTimes(1);
  });
  it('keeps a fresh turn original writer instead of replacing it with a shared endpoint', async () => {
    const { handle, dir } = await setup();
    const request = parseCodexAsyncInput('thread', 'turn', asyncItem)!;
    const respond = vi.fn(async () => true);
    handle.accept({ requestId: request.itemId, request, respond }, 'fresh-run');
    handle.observeSnapshot(asyncSnapshot()); const d = await delivery(dir);
    await handle.handleAction('oc_group', d.messageId, d.token, { custom_0: 'C' });
    expect(respond).toHaveBeenCalledWith({ [request.questions[0]!.id]: { answers: ['C'] } });
  });
  it('keeps remaining questions usable after a partial Desktop reply, with stable form indexes', async () => {
    const snapshot = asyncSnapshot();
    snapshot.turns[0]!.items = [{ ...asyncItem, questions: [
      { title: 'First', options: ['A', 'B'] }, { title: 'Second', options: ['C', 'D'] },
    ] }];
    const request = parseCodexAsyncInput('thread', 'turn', snapshot.turns[0]!.items[0]!)!;
    const writer = { readThread: async () => snapshot, steerTurn: vi.fn(async (_thread: string, _turn: string, _text: string) => {}) };
    const { handle, channel, dir } = await setup(undefined, 'active', writer);
    handle.observeSnapshot(snapshot); const d = await delivery(dir);
    snapshot.turns[0]!.items.push({ type: 'userMessage', content: [{ type: 'text',
      text: serializeCodexAsyncAnswers(request, { [request.questions[0]!.id]: { answers: ['A'] } }) }] });
    handle.observeSnapshot(snapshot);
    await vi.waitFor(() => expect(JSON.stringify(channel.rawClient.requests.at(-1))).toContain('已在其他端回答'));
    expect(channel.sent).toHaveLength(1);
    await handle.handleAction('oc_group', d.messageId, d.token, { q_0: '1', q_1: '1' });
    const text = writer.steerTurn.mock.calls[0]?.[2];
    expect(text).toContain('"answer":"D"');
    expect(text).not.toContain('"question":"First"');
  });
  it('does not label an in-flight answer successful after restarting before acknowledgement', async () => {
    let finish!: () => void;
    const writer = { readThread: async () => asyncSnapshot(), steerTurn: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) };
    const one = await setup(undefined, 'active', writer);
    one.handle.observeSnapshot(asyncSnapshot()); const d = await delivery(one.dir);
    const submission = one.handle.handleAction('oc_group', d.messageId, d.token, { q_0: '0' });
    await vi.waitFor(() => expect(writer.steerTurn).toHaveBeenCalledTimes(1));
    const saved = JSON.parse(await readFile(join(one.dir, 'codex-user-input.json'), 'utf8'));
    expect(saved.entries[0][1].status).toBe('submitting');
    const two = await setup(one.dir, 'active', writer); two.handle.observeSnapshot(asyncSnapshot());
    await expect(two.handle.handleAction('oc_group', d.messageId, d.token, { q_0: '1' })).rejects.toThrow('已回答');
    expect(writer.steerTurn).toHaveBeenCalledTimes(1);
    finish(); await submission;
  });
});
