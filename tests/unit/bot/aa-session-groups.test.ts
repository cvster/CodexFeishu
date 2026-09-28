import { describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { Controls } from '../../../src/commands/index.js';
import type { SessionCatalog, SessionCatalogEntry } from '../../../src/session/catalog.js';
import type { WorkspaceStore } from '../../../src/workspace/store.js';
import {
  isAaSession,
  syncAaSessionGroupsOnce,
} from '../../../src/bot/aa-session-groups.js';

describe('AA session automatic groups', () => {
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

  it('creates and binds one group per unbound AA session without duplicating it', async () => {
    const created: Array<{ name: string; inviteUserIds: string[] }> = [];
    const channel = {
      listChats: vi.fn(async () => []),
      createChat: vi.fn(async (input: { name: string; inviteUserIds: string[] }) => {
        created.push(input);
        return { chatId: `oc_auto_${created.length}` };
      }),
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
    expect(created[0]).toMatchObject({ name: 'AA自动群', inviteUserIds: ['ou_owner', 'ou_admin'] });
    expect(sessionCatalog.upsertActive).toHaveBeenCalledTimes(1);
    expect(workspaces.setCwd).toHaveBeenCalledWith('oc_auto_1', process.cwd());
  });
});
