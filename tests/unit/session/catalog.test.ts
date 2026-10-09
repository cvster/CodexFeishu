import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionCatalog,
  sessionCatalogKey,
} from '../../../src/session/catalog.js';

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware session catalog', () => {
  it('keeps true archive tombstones across GC/restart and only clears the group on explicit rebinding', async () => {
    const file = await path();
    const catalog = new SessionCatalog(file);
    const identity = { scopeId: 'oc_archived', agentId: 'codex' as const, cwdRealpath: '/repo', policyFingerprint: 'fp' };
    catalog.upsertActive({ ...identity, threadId: 'old', now: 1 });
    catalog.archiveCodexThread('old', 2);
    catalog.gc({ now: 1_000_000, maxArchivedAgeMs: 1, maxEntriesPerProfile: 0 });
    await catalog.flush();
    const loaded = new SessionCatalog(file); await loaded.load();
    expect(loaded.isScopeArchived('oc_archived')).toBe(true);
    expect(loaded.isThreadArchived('old')).toBe(true);
    expect(() => loaded.upsertActive({ ...identity, threadId: 'old' })).toThrow('已归档');
    expect(() => loaded.upsertActive({ ...identity, threadId: 'new' })).toThrow('已归档');
    loaded.upsertActive({ ...identity, threadId: 'new', rebindArchivedScope: true });
    expect(loaded.isScopeArchived('oc_archived')).toBe(false);
    expect(loaded.isThreadArchived('old')).toBe(true);
    expect(loaded.activeFor(identity)?.threadId).toBe('new');
    await loaded.flush();
  });

  it('does not close a group when retiring a binding or archiving an older thread', async () => {
    const catalog = new SessionCatalog(await path());
    const identity = { scopeId: 'oc_group', agentId: 'codex' as const, cwdRealpath: '/repo', policyFingerprint: 'fp' };
    catalog.upsertActive({ ...identity, threadId: 'old', now: 1 });
    catalog.archiveActive(identity);
    expect(catalog.isScopeArchived('oc_group')).toBe(false);
    catalog.upsertActive({ ...identity, policyFingerprint: 'fp2', threadId: 'new', now: Date.now() + 1 });
    catalog.archiveCodexThread('old');
    expect(catalog.isScopeArchived('oc_group')).toBe(false);
    await catalog.flush();
  });

  it.each([false, true])('closes the actual current binding even when an older archive has a newer timestamp (same time: %s)', async (sameTime) => {
    const catalog = new SessionCatalog(await path());
    const identity = { scopeId: 'oc_group', agentId: 'codex' as const, cwdRealpath: '/repo', policyFingerprint: 'old' };
    catalog.upsertActive({ ...identity, threadId: 'older', now: 1 });
    catalog.upsertActive({ ...identity, policyFingerprint: 'current', threadId: 'current', now: sameTime ? 1 : 2 });
    catalog.archiveCodexThread('older', 3);
    expect(catalog.isScopeArchived('oc_group')).toBe(false);
    catalog.archiveCodexThread('current', 4);
    expect(catalog.isScopeArchived('oc_group')).toBe(true);
    await catalog.flush();
  });

  it('surfaces archive-ledger persistence failure instead of claiming durable success', async () => {
    const file = await path(); const catalog = new SessionCatalog(file);
    catalog.upsertActive({ scopeId: 'oc_group', agentId: 'codex', cwdRealpath: '/repo', policyFingerprint: 'p', threadId: 'thread' });
    await catalog.flush();
    await rm(`${file}.archives.json`); await mkdir(`${file}.archives.json`);
    catalog.archiveCodexThread('thread');
    await expect(catalog.flush()).rejects.toBeDefined();
    expect(catalog.isScopeArchived('oc_group')).toBe(true);
  });

  it('retires other stale active bindings in a group when its current thread is archived', async () => {
    const catalog = new SessionCatalog(await path());
    const base = { scopeId: 'oc_group', agentId: 'codex' as const, cwdRealpath: '/repo' };
    catalog.upsertActive({ ...base, policyFingerprint: 'old', threadId: 'old', now: 1 });
    catalog.upsertActive({ ...base, policyFingerprint: 'new', threadId: 'new', now: 2 });
    catalog.archiveCodexThread('new', 3);
    expect(catalog.entries().every((e) => e.status === 'archived')).toBe(true);
    expect(catalog.isThreadArchived('old')).toBe(false);
    await catalog.flush();
  });

  it('uses the last established binding when an existing key is reused within the same millisecond', async () => {
    const catalog = new SessionCatalog(await path());
    const base = { scopeId: 'oc_group', agentId: 'codex' as const, cwdRealpath: '/repo' };
    catalog.upsertActive({ ...base, policyFingerprint: 'fp1', threadId: 'first', now: 1 });
    catalog.upsertActive({ ...base, policyFingerprint: 'fp2', threadId: 'second', now: 2 });
    catalog.upsertActive({ ...base, policyFingerprint: 'fp1', threadId: 'current', now: 2 });
    catalog.archiveCodexThread('current', 3);
    expect(catalog.isScopeArchived('oc_group')).toBe(true); await catalog.flush();
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('keys entries by scope, agent, cwd realpath, and policy fingerprint', () => {
    expect(
      sessionCatalogKey({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBe('chat-1\x1fclaude\x1f/repo\x1ffp-1');
  });

  it('stores Claude sessions and Codex threads in isolated active entries', async () => {
    const catalog = new SessionCatalog(await path());

    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      sessionId: 'sess-1',
      now: 1000,
    });
    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      threadId: 'thread-1',
      now: 2000,
    });

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ sessionId: 'sess-1', agentId: 'claude' });
    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ threadId: 'thread-1', agentId: 'codex' });
    await catalog.flush();
  });

  it('persists the Feishu bot app that established a binding', async () => {
    const catalogPath = await path();
    const catalog = new SessionCatalog(catalogPath);
    const identity = {
      scopeId: 'chat-1',
      agentId: 'codex' as const,
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };

    catalog.upsertActive({
      ...identity,
      threadId: 'thread-1',
      botAppId: 'cli_current',
    });
    await catalog.flush();

    const reloaded = new SessionCatalog(catalogPath);
    await reloaded.load();
    expect(reloaded.activeFor(identity)).toMatchObject({
      threadId: 'thread-1',
      botAppId: 'cli_current',
    });
  });

  it('consumes a creation-time replay marker and allows an explicit clear on rebinding', async () => {
    const catalog = new SessionCatalog(await path());
    const identity = {
      scopeId: 'chat-replay',
      agentId: 'codex' as const,
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-replay',
    };
    catalog.upsertActive({
      ...identity,
      threadId: 'thread-1',
      recentTurnReplayCount: 3,
    });
    expect(catalog.activeFor(identity)?.recentTurnReplayCount).toBe(3);
    expect(catalog.clearRecentTurnReplay('chat-replay', 'thread-1')).toBe(1);
    expect(catalog.activeFor(identity)?.recentTurnReplayCount).toBeUndefined();

    catalog.upsertActive({
      ...identity,
      threadId: 'thread-2',
      recentTurnReplayCount: 3,
    });
    catalog.upsertActive({
      ...identity,
      threadId: 'thread-2',
      recentTurnReplayCount: null,
    });
    expect(catalog.activeFor(identity)?.recentTurnReplayCount).toBeUndefined();
    await catalog.flush();
  });

  it('rejects mismatched Claude/Codex identity fields and does not auto-resume damaged entries', async () => {
    const catalog = new SessionCatalog(await path());

    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        threadId: 'thread-wrong',
        now: 1000,
      }),
    ).toThrow(/Claude.*sessionId/i);
    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        sessionId: 'sess-wrong',
        now: 1000,
      }),
    ).toThrow(/Codex.*threadId/i);

    await catalog.replaceForTest([
      {
        key: sessionCatalogKey({
          scopeId: 'chat-1',
          agentId: 'codex',
          cwdRealpath: '/repo',
          policyFingerprint: 'fp-1',
        }),
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        sessionId: 'sess-damaged',
        status: 'active',
        updatedAt: 1000,
      },
    ]);

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBeUndefined();
    await catalog.flush();
  });

  it('archives only the current agent/cwd/fingerprint entry for a new conversation', async () => {
    const catalog = new SessionCatalog(await path());
    const base = {
      scopeId: 'chat-1',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };
    catalog.upsertActive({ ...base, agentId: 'claude', sessionId: 'sess-1', now: 1000 });
    catalog.upsertActive({ ...base, agentId: 'codex', threadId: 'thread-1', now: 1000 });

    expect(catalog.archiveActive({ ...base, agentId: 'claude', now: 2000 })).toBe(true);

    expect(catalog.activeFor({ ...base, agentId: 'claude' })).toBeUndefined();
    expect(catalog.activeFor({ ...base, agentId: 'codex' })).toMatchObject({
      threadId: 'thread-1',
    });
    expect(catalog.entries().filter((entry) => entry.status === 'archived')).toHaveLength(1);
    await catalog.flush();
  });

  it('migrates the newest legacy fingerprint once without weakening future policy changes', async () => {
    const catalog = new SessionCatalog(await path());
    await catalog.replaceForTest([
      entry('chat-1', 'sess-old', 1000, 'legacy-fp-1'),
      entry('chat-1', 'sess-newest', 2000, 'legacy-fp-2'),
    ]);

    const migratedIdentity = {
      scopeId: 'chat-1',
      agentId: 'claude' as const,
      cwdRealpath: '/repo',
      policyFingerprint: 'v3-fp',
    };
    expect(catalog.activeFor(migratedIdentity)).toMatchObject({
      sessionId: 'sess-newest',
      fingerprintVersion: 3,
      policyFingerprint: 'v3-fp',
    });
    expect(catalog.entries().filter((item) => item.status === 'archived')).toHaveLength(2);
    expect(
      catalog.activeFor({ ...migratedIdentity, policyFingerprint: 'future-policy-change' }),
    ).toBeUndefined();
    await catalog.flush();
  });

  it('garbage-collects old archived entries, per-scope overflow, and profile overflow', async () => {
    const catalog = new SessionCatalog(await path());
    await catalog.replaceForTest([
      ...Array.from({ length: 25 }, (_, i) =>
        entry(`chat-1`, `sess-${i}`, 50_000 + i, `fp-${i}`),
      ),
      ...Array.from({ length: 981 }, (_, i) =>
        entry(`chat-${i + 2}`, `other-${i}`, 20_000 + i, `fp-other-${i}`),
      ),
      {
        ...entry('chat-old', 'old', 1),
        status: 'archived',
      },
    ]);

    catalog.gc({
      now: 100 * 24 * 60 * 60 * 1000,
      maxArchivedAgeMs: 90 * 24 * 60 * 60 * 1000,
      maxEntriesPerScope: 20,
      maxEntriesPerProfile: 1000,
    });

    expect(catalog.entries().some((item) => item.sessionId === 'old')).toBe(false);
    expect(catalog.entries().filter((item) => item.scopeId === 'chat-1')).toHaveLength(20);
    expect(catalog.entries()).toHaveLength(1000);
    await catalog.flush();
  });
});

async function path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-catalog-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'catalog.json');
}

function entry(
  scopeId: string,
  sessionId: string,
  updatedAt: number,
  policyFingerprint = 'fp-1',
) {
  const identity = {
    scopeId,
    agentId: 'claude' as const,
    cwdRealpath: '/repo',
    policyFingerprint,
  };
  return {
    key: sessionCatalogKey(identity),
    ...identity,
    sessionId,
    status: 'active' as const,
    updatedAt,
  };
}
