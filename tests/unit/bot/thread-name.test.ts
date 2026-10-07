import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexNameSync } from '../../../src/bot/thread-name.js';
import type { SessionCatalogEntry } from '../../../src/session/catalog.js';
import { normalizeCodexThreadSnapshot } from '../../../src/session/codex-thread-reader.js';

describe('bidirectional Codex / Feishu naming', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'codex-name-sync-')); cleanup.push(dir);
    let groupName = '群名1'; let threadName = '群名1'; let now = 1_000;
    const getChatInfo = vi.fn(async () => ({ name: groupName }));
    const getChatMode = vi.fn(async () => 'group');
    const setThreadName = vi.fn(async (_id: string, name: string) => { threadName = name; });
    const update = vi.fn(async (args: { data: { name: string } }) => { groupName = args.data.name; return { code: 0 }; });
    const knownChats = [{ id: 'oc_group', name: groupName }];
    const options = {
      channel: { getChatInfo, getChatMode, rawClient: { im: { v1: { chat: { update } } } } } as never,
      agent: { setThreadName }, appId: 'bot', statePath: join(dir, 'names.json'),
      now: () => now, knownChats: () => knownChats,
    };
    const entry: SessionCatalogEntry = { key: 'key', scopeId: 'oc_group', threadId: 'thread',
      botAppId: 'bot', agentId: 'codex', status: 'active', cwdRealpath: dir, policyFingerprint: 'p', updatedAt: 1 };
    let sync = new CodexNameSync(options); await sync.load();
    return {
      getChatInfo, getChatMode, setThreadName, update, knownChats, entry,
      group: (name: string) => { groupName = name; },
      thread: (name: string) => { threadName = name; },
      advance: (ms = 10_000) => { now += ms; },
      observe: (entries = [entry]) => sync.observe({ id: 'thread', name: threadName, turns: [] }, entries),
      restart: async () => { sync = new CodexNameSync(options); await sync.load(); },
    };
  }

  it('applies each group rename once, then allows session renames to flow back', async () => {
    const f = await setup(); await f.observe();
    f.group('群名2'); f.advance(); await f.observe();
    await f.observe(); f.advance(); await f.observe();
    expect(f.setThreadName).toHaveBeenCalledTimes(1);
    expect(f.setThreadName).toHaveBeenCalledWith('thread', '群名2');
    f.thread('桌面改名'); await f.observe();
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenCalledWith({ path: { chat_id: 'oc_group' }, data: { name: '桌面改名' } });
    expect(f.knownChats[0]?.name).toBe('桌面改名');
    f.advance(); await f.observe();
    expect(f.setThreadName).toHaveBeenCalledTimes(1); expect(f.update).toHaveBeenCalledTimes(1);
    f.group('群名3'); f.advance(); await f.observe();
    expect(f.setThreadName).toHaveBeenCalledTimes(2);
  });

  it('keeps the baseline across restarts instead of reverting a desktop rename', async () => {
    const f = await setup(); await f.observe(); await f.restart();
    f.thread('重启后改名'); await f.observe();
    expect(f.update).toHaveBeenCalledTimes(1); expect(f.setThreadName).not.toHaveBeenCalled();
    await f.restart(); await f.observe();
    expect(f.update).toHaveBeenCalledTimes(1);
  });

  it('initializes a new binding from the group just once, including unnamed threads', async () => {
    const f = await setup(); f.thread(''); await f.observe();
    f.advance(); await f.observe(); await f.restart(); await f.observe();
    expect(f.setThreadName).toHaveBeenCalledTimes(1);
    expect(f.setThreadName).toHaveBeenCalledWith('thread', '群名1');
    expect(f.update).not.toHaveBeenCalled();
  });

  it('ignores delayed thread-name echoes even across restart', async () => {
    const f = await setup(); await f.observe();
    f.setThreadName.mockImplementation(async () => {});
    f.group('群名2'); f.advance(); await f.observe();
    await f.restart(); f.advance(); await f.observe();
    expect(f.setThreadName).toHaveBeenCalledTimes(1); expect(f.update).not.toHaveBeenCalled();
    f.thread('群名2'); await f.observe(); // acknowledgement before Feishu's next check
    f.thread('群名1'); await f.observe();
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenCalledWith({ path: { chat_id: 'oc_group' }, data: { name: '群名1' } });
  });

  it('ignores delayed group-name echoes without ping-pong writes', async () => {
    const f = await setup(); await f.observe();
    f.update.mockImplementation(async () => ({ code: 0 }));
    f.thread('桌面改名'); await f.observe();
    await f.restart(); f.advance(); await f.observe();
    expect(f.update).toHaveBeenCalledTimes(1); expect(f.setThreadName).not.toHaveBeenCalled();
    f.group('桌面改名'); f.advance(); await f.observe();
    f.group('群名1'); f.advance(); await f.observe();
    expect(f.setThreadName).toHaveBeenCalledTimes(1);
    expect(f.setThreadName).toHaveBeenCalledWith('thread', '群名1');
  });

  it('gives an independently changed group priority when both sides changed', async () => {
    const f = await setup(); await f.observe();
    f.thread('桌面改名'); f.group('群改名'); await f.observe();
    expect(f.setThreadName).toHaveBeenCalledTimes(1);
    expect(f.setThreadName).toHaveBeenCalledWith('thread', '群改名');
    expect(f.update).not.toHaveBeenCalled();
  });

  it('does not use cached group names when live lookup fails', async () => {
    const f = await setup(); await f.observe();
    f.thread('桌面改名'); f.getChatInfo.mockRejectedValueOnce(new Error('offline')); await f.observe();
    expect(f.setThreadName).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
    f.advance(); await f.observe(); expect(f.update).toHaveBeenCalledTimes(1);
  });

  it('retries failed session writes without treating failure as a completed sync', async () => {
    const f = await setup(); await f.observe();
    f.group('群名2'); f.setThreadName.mockRejectedValueOnce(new Error('offline'));
    f.advance(); await f.observe(); await f.observe();
    expect(f.setThreadName).toHaveBeenCalledTimes(1);
    f.advance(); await f.observe(); f.advance(); await f.observe();
    expect(f.setThreadName).toHaveBeenCalledTimes(2); expect(f.update).not.toHaveBeenCalled();
  });

  it('retries Feishu rejected renames without overwriting the session', async () => {
    const f = await setup(); await f.observe();
    f.thread('桌面改名'); f.update.mockResolvedValueOnce({ code: 232017 });
    await f.observe(); await f.observe(); expect(f.update).toHaveBeenCalledTimes(1);
    f.advance(); await f.observe(); expect(f.update).toHaveBeenCalledTimes(2);
    expect(f.setThreadName).not.toHaveBeenCalled();
  });

  it('does not repeatedly fetch group information for every 2-second snapshot', async () => {
    const f = await setup(); await f.observe();
    for (let i = 0; i < 4; i++) { f.advance(2_000); await f.observe(); }
    expect(f.getChatInfo).toHaveBeenCalledTimes(1);
    f.advance(2_000); await f.observe(); expect(f.getChatInfo).toHaveBeenCalledTimes(2);
  });

  it('ignores wrong bot, legacy, topic, archived and mismatched thread bindings', async () => {
    const f = await setup();
    await f.observe([
      { ...f.entry, botAppId: 'other' }, { ...f.entry, botAppId: undefined },
      { ...f.entry, scopeId: 'oc_group:topic' }, { ...f.entry, status: 'archived' },
      { ...f.entry, threadId: 'other' },
    ]);
    expect(f.getChatInfo).not.toHaveBeenCalled();
  });

  it('ignores direct chats and deduplicates repeated catalog entries', async () => {
    const f = await setup(); f.getChatMode.mockResolvedValueOnce('p2p');
    await f.observe(); expect(f.getChatInfo).not.toHaveBeenCalled();
    const g = await setup(); g.thread('old'); await g.observe([g.entry, g.entry]);
    expect(g.setThreadName).toHaveBeenCalledTimes(1);
  });

  it('retains the public app-server thread name in normalized snapshots', () => {
    expect(normalizeCodexThreadSnapshot({ id: 'thread', name: '桌面改名', turns: [] }))
      .toMatchObject({ id: 'thread', name: '桌面改名' });
  });
});
