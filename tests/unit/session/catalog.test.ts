import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionCatalog,
  sessionCatalogKey,
} from '../../../src/session/catalog.js';

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware session catalog', () => {
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
