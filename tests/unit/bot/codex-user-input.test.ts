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

describe('Codex user input lifecycle', () => {
  const handles: CodexInputHandle[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.stop()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function setup(dir?: string, liveStatus = 'notLoaded') {
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
        readThreadStatus: vi.fn(async () => ({ type: liveStatus, activeFlags: [] })) }) });
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
});
