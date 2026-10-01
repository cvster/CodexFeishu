import { describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { Controls } from '../../../src/commands/index.js';
import type { SessionCatalog, SessionCatalogEntry } from '../../../src/session/catalog.js';
import type { WorkspaceStore } from '../../../src/workspace/store.js';
import {
  aaSessionVersion,
  isAaSession,
  syncAaSessionGroupsOnce,
  startAaSessionGroupSync,
} from '../../../src/bot/aa-session-groups.js';

describe('AA session automatic groups', () => {
  it('pauses scans during native fork naming and resumes them after an error', async () => {
    const historyProvider = vi.fn(async () => []);
    const profileConfig = createDefaultProfileConfig({ agentKind: 'codex',
      accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
      codex: { binaryPath: 'codex' } });
    const handle = startAaSessionGroupSync({
      channel: { listChats: async () => [] } as unknown as LarkChannel,
      controls: { profileConfig, botOwnerId: 'ou_owner' } as Controls,
      sessionCatalog: { entries: () => [] } as unknown as SessionCatalog,
      workspaces: {} as WorkspaceStore,
      profileStateDir: process.cwd(), historyProvider,
    });
    try {
      await handle.runNow();
      const calls = historyProvider.mock.calls.length;
      await expect(handle.withPaused(async () => {
        await handle.runNow();
        expect(historyProvider).toHaveBeenCalledTimes(calls);
        throw new Error('fork failed');
      })).rejects.toThrow('fork failed');
      await handle.runNow();
      expect(historyProvider).toHaveBeenCalledTimes(calls + 1);
    } finally { handle.stop(); }
  });
  it('matches only named sessions whose trimmed name starts with uppercase AA', () => {
    const base = {
      threadId: 'thread-1',
      preview: 'AA preview is not a name',
      cwd: process.cwd(),
      createdAtMs: 1,
      updatedAtMs: 2,
      source: 'exec',
    };
    expect(isAaSession({ ...base, name: '  AA project' })).toBe(true);
    expect(isAaSession({ ...base, name: 'aa project' })).toBe(false);
    expect(isAaSession(base)).toBe(false);
  });

  it('recognizes one or two trailing digits as a session version', () => {
    expect(aaSessionVersion('AA-脚踝自动标零3 (1)')).toEqual({ family: 'AA-脚踝自动标零3 (1)' });
    expect(aaSessionVersion('AA-脚踝自动标零2')).toEqual({
      family: 'AA-脚踝自动标零',
      version: 2,
    });
    expect(aaSessionVersion('AA-脚踝自动标零12')).toEqual({
      family: 'AA-脚踝自动标零',
      version: 12,
    });
    expect(aaSessionVersion('AA-t3-ota模型下载2-Wait')).toEqual({
      family: 'AA-t3-ota模型下载2-Wait',
    });
  });

  it('creates and binds one group per unbound AA session without duplicating it', async () => {
    const created: Array<{ name: string; inviteUserIds: string[]; ownerOpenId?: string }> = [];
    const channel = {
      listChats: vi.fn(async () => created.map((chat, index) => ({
        id: `oc_auto_${index + 1}`,
        name: chat.name,
      }))),
      rawClient: { im: { v1: { chat: { create: vi.fn(async (input: {
        data: { name: string; user_id_list: string[]; owner_id?: string };
      }) => {
        created.push({
          name: input.data.name,
          inviteUserIds: input.data.user_id_list,
          ownerOpenId: input.data.owner_id,
        });
        return { code: 0, data: { chat_id: `oc_auto_${created.length}` } };
      }) } } } },
      createCard: vi.fn(async () => ({ cardId: 'card-1' })),
      send: vi.fn(async () => ({ messageId: 'om-1' })),
    } as unknown as LarkChannel;
    const profileConfig = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
      codex: { binaryPath: 'codex' },
      access: { allowedChats: ['*'], admins: ['ou_admin'] },
      permissions: { defaultAccess: 'full', maxAccess: 'full' },
    });
    const controls = {
      profile: 'codex',
      profileConfig,
      botOwnerId: 'ou_owner',
      ownerRefreshState: 'ok',
      configPath: 'unused.json',
      cfg: { preferences: {} },
      processId: 'test',
      knownChats: [],
      refreshOwner: vi.fn(),
      restart: vi.fn(),
      exit: vi.fn(),
    } as unknown as Controls;
    const catalogEntries: SessionCatalogEntry[] = [];
    const sessionCatalog = {
      entries: () => [...catalogEntries],
      archiveThread: vi.fn((threadId: string) => {
        let archived = 0;
        for (const entry of catalogEntries) {
          if (entry.status !== 'active' || entry.threadId !== threadId) continue;
          entry.status = 'archived';
          archived += 1;
        }
        return archived;
      }),
      upsertActive: vi.fn((input: SessionCatalogEntry) => {
        const entry = { ...input, key: 'key', status: 'active', createdAt: 1, updatedAt: 1 } as SessionCatalogEntry;
        catalogEntries.push(entry);
        return entry;
      }),
      flush: vi.fn(async () => undefined),
    } as unknown as SessionCatalog;
    const workspaces = {
      setCwd: vi.fn(),
      flush: vi.fn(async () => undefined),
    } as unknown as WorkspaceStore;
    const historyProvider = vi.fn(async () => [
      {
        threadId: 'thread-aa',
        name: 'AA自动群',
        preview: 'prompt',
        cwd: process.cwd(),
        createdAtMs: 1,
        updatedAtMs: 2,
        source: 'exec',
      },
      {
        threadId: 'thread-other',
        name: '普通会话',
        preview: 'prompt',
        cwd: process.cwd(),
        createdAtMs: 1,
        updatedAtMs: 2,
        source: 'exec',
      },
    ]);

    const deps = {
      channel,
      controls,
      sessionCatalog,
      workspaces,
      profileStateDir: process.cwd(),
      historyProvider,
    };
    await syncAaSessionGroupsOnce(deps);
    await syncAaSessionGroupsOnce(deps);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: 'AA自动群',
      inviteUserIds: ['ou_owner', 'ou_admin'],
      ownerOpenId: 'ou_owner',
    });
    expect(sessionCatalog.upsertActive).toHaveBeenCalledTimes(1);
    expect(workspaces.setCwd).toHaveBeenCalledWith('oc_auto_1', process.cwd());
  });

  it('creates only the highest trailing-number version during an initial scan', async () => {
    const h = createHarness([
      historyThread('thread-v2', 'AA-脚踝自动标零2', 2),
      historyThread('thread-v3', 'AA-脚踝自动标零3', 3),
    ]);

    await syncAaSessionGroupsOnce(h.deps);

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      name: 'AA-脚踝自动标零3',
      inviteUserIds: ['ou_owner'],
    });
    expect(h.sessionCatalog.upsertActive).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-v3', recentTurnReplayCount: 3 }),
    );
  });

  it('reuses and renames the previous version group for a newer session', async () => {
    const history = [
      historyThread('thread-v2', 'AA-脚踝自动标零2', 2),
      historyThread('thread-v3', 'AA-脚踝自动标零3', 3),
    ];
    const h = createHarness(history, {
      knownChats: [{ id: 'oc_existing', name: 'AA-脚踝自动标零2' }],
      entries: [catalogEntry('oc_existing', 'thread-v2')],
    });

    await syncAaSessionGroupsOnce(h.deps);

    expect(h.created).toHaveLength(0);
    expect(h.channel.rawClient.im.v1.chat.update).toHaveBeenCalledWith({
      path: { chat_id: 'oc_existing' },
      data: { name: 'AA-脚踝自动标零3' },
    });
    expect(h.sessionCatalog.archiveActive).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-v2' }),
    );
    expect(h.sessionCatalog.upsertActive).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'oc_existing',
        threadId: 'thread-v3',
        botAppId: 'cli_test',
        recentTurnReplayCount: null,
      }),
    );
  });

  it('does not let a binding from a chat invisible to the current bot suppress creation', async () => {
    const h = createHarness(
      [historyThread('thread-aa', 'AA-远程任务', 2)],
      { entries: [catalogEntry('oc_old_bot', 'thread-aa', 'cli_old')] },
    );

    await syncAaSessionGroupsOnce(h.deps);

    expect(h.created).toHaveLength(1);
    expect(h.sessionCatalog.archiveThread).toHaveBeenCalledWith('thread-aa');
    expect(h.sessionCatalog.upsertActive).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'oc_auto_1',
        threadId: 'thread-aa',
        botAppId: 'cli_test',
        recentTurnReplayCount: 3,
      }),
    );
  });

  it('does not accept a visible binding tagged for another bot app', async () => {
    const h = createHarness(
      [historyThread('thread-aa', 'AA-共享群任务', 2)],
      {
        knownChats: [{ id: 'oc_shared', name: 'AA-共享群任务' }],
        entries: [catalogEntry('oc_shared', 'thread-aa', 'cli_old')],
      },
    );

    await syncAaSessionGroupsOnce(h.deps);

    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.name).toBe('AA-共享群任务-2');
  });

  it('keeps a visible legacy binding without a bot app id for compatibility', async () => {
    const h = createHarness(
      [historyThread('thread-aa', 'AA-已有任务', 2)],
      {
        knownChats: [{ id: 'oc_existing', name: 'AA-已有任务' }],
        entries: [catalogEntry('oc_existing', 'thread-aa')],
      },
    );

    await syncAaSessionGroupsOnce(h.deps);

    expect(h.created).toHaveLength(0);
  });

  it('skips reconciliation when the current bot chat list cannot be fetched', async () => {
    const h = createHarness(
      [historyThread('thread-aa', 'AA-远程任务', 2)],
      {
        entries: [catalogEntry('oc_old_bot', 'thread-aa', 'cli_old')],
        listChatsError: new Error('network unavailable'),
      },
    );

    await syncAaSessionGroupsOnce(h.deps);

    expect(h.created).toHaveLength(0);
    expect(h.sessionCatalog.archiveThread).not.toHaveBeenCalled();
  });
});

function historyThread(threadId: string, name: string, updatedAtMs: number) {
  return {
    threadId,
    name,
    preview: 'prompt',
    cwd: process.cwd(),
    createdAtMs: 1,
    updatedAtMs,
    source: 'exec',
  } as const;
}

function catalogEntry(scopeId: string, threadId: string, botAppId?: string): SessionCatalogEntry {
  return {
    key: `${scopeId}-key`,
    scopeId,
    agentId: 'codex',
    cwdRealpath: process.cwd(),
    policyFingerprint: 'policy',
    status: 'active',
    updatedAt: 1,
    threadId,
    ...(botAppId ? { botAppId } : {}),
  };
}

function createHarness(
  history: ReturnType<typeof historyThread>[],
  options: {
    knownChats?: Array<{ id: string; name: string }>;
    entries?: SessionCatalogEntry[];
    listChatsError?: Error;
  } = {},
) {
  const created: Array<{ name: string; inviteUserIds: string[]; ownerOpenId?: string }> = [];
  const knownChats = options.knownChats ?? [];
  const channel = {
    listChats: vi.fn(async () => {
      if (options.listChatsError) throw options.listChatsError;
      return knownChats;
    }),
    createCard: vi.fn(async () => ({ cardId: 'card-1' })),
    send: vi.fn(async () => ({ messageId: 'om-1' })),
    rawClient: {
      im: { v1: { chat: {
        create: vi.fn(async (input: {
          data: { name: string; user_id_list: string[]; owner_id?: string };
        }) => {
          created.push({
            name: input.data.name,
            inviteUserIds: input.data.user_id_list,
            ownerOpenId: input.data.owner_id,
          });
          return { code: 0, data: { chat_id: `oc_auto_${created.length}` } };
        }),
        update: vi.fn(async () => ({ code: 0 })),
      } } },
    },
  };
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
    access: { allowedChats: ['*'], admins: [] },
    permissions: { defaultAccess: 'full', maxAccess: 'full' },
  });
  const controls = {
    profile: 'codex',
    profileConfig,
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    configPath: 'unused.json',
    cfg: { preferences: {} },
    processId: 'test',
    knownChats,
    refreshOwner: vi.fn(),
    restart: vi.fn(),
    exit: vi.fn(),
  } as unknown as Controls;
  const entries = [...(options.entries ?? [])];
  const sessionCatalog = {
    entries: () => [...entries],
    archiveThread: vi.fn((threadId: string) => {
      let archived = 0;
      for (const entry of entries) {
        if (entry.status !== 'active' || entry.threadId !== threadId) continue;
        entry.status = 'archived';
        archived += 1;
      }
      return archived;
    }),
    archiveActive: vi.fn((entry: SessionCatalogEntry) => {
      const stored = entries.find((candidate) => candidate.key === entry.key);
      if (stored) stored.status = 'archived';
      return Boolean(stored);
    }),
    upsertActive: vi.fn((input: SessionCatalogEntry) => {
      const entry = { ...input, key: `${input.scopeId}-new`, status: 'active', updatedAt: 2 } as SessionCatalogEntry;
      entries.push(entry);
      return entry;
    }),
    flush: vi.fn(async () => undefined),
  } as unknown as SessionCatalog;
  const workspaces = {
    setCwd: vi.fn(),
    flush: vi.fn(async () => undefined),
  } as unknown as WorkspaceStore;
  return {
    created,
    channel,
    sessionCatalog,
    deps: {
      channel: channel as unknown as LarkChannel,
      controls,
      sessionCatalog,
      workspaces,
      profileStateDir: process.cwd(),
      historyProvider: vi.fn(async () => history),
    },
  };
}
