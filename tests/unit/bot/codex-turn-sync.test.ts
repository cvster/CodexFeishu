import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionCatalog, type SessionCatalogEntry } from '../../../src/session/catalog.js';
import type { CodexThreadSnapshot } from '../../../src/session/codex-thread-reader.js';
import { startCodexTurnSync } from '../../../src/bot/codex-turn-sync.js';
import { registerCodexQueuedTurnClaim } from '../../../src/session/codex-origin.js';
import { createFakeChannel } from '../../helpers/fake-channel.js';

describe('Codex desktop turn sync', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('mirrors external turns, ignores bridge turns, and resumes without duplicates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-sync-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const entry = {
      key: 'entry',
      scopeId: 'oc_group',
      agentId: 'codex',
      cwdRealpath: dir,
      policyFingerprint: 'policy',
      status: 'active',
      updatedAt: 1,
      threadId: 'thread-1',
    } satisfies SessionCatalogEntry;
    const sessionCatalog = {
      entries: () => [entry],
    } as unknown as SessionCatalog;
    const controls = controlsForCodex();
    let nowMs = 10_000;
    let snapshot: CodexThreadSnapshot = {
      id: 'thread-1',
      turns: [externalTurn('old-turn', 'completed', 'old prompt', 'old answer')],
    };
    const reader = {
      readThread: vi.fn(async () => snapshot),
      stop: vi.fn(async () => undefined),
    };
    const statePath = join(dir, 'sync-state.json');
    const handle = await startCodexTurnSync({
      channel: channel as unknown as LarkChannel,
      controls,
      sessionCatalog,
      profileStateDir: dir,
      statePath,
      intervalMs: 60_000,
      reader,
      now: () => nowMs,
    });
    await handle.runNow();
    expect(channel.sent).toHaveLength(0);

    snapshot = {
      id: 'thread-1',
      turns: [
        ...snapshot.turns,
        bridgeTurn('bridge-turn'),
        externalTurn('desktop-turn', 'inProgress', 'desktop prompt', ''),
      ],
    };
    nowMs += 3_000;
    const updateCardById = channel.updateCardById.bind(channel);
    const updateSpy = vi.spyOn(channel, 'updateCardById')
      .mockImplementation(updateCardById)
      .mockRejectedValueOnce(new Error('transient'));
    await handle.runNow();
    nowMs += 100;
    await handle.runNow();
    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[0]?.content).toMatchObject({
      markdown: expect.stringContaining('desktop prompt'),
    });
    expect(JSON.stringify(channel.sent[1]?.content)).toContain('运行中');
    expect(JSON.stringify(channel.sent[1]?.content)).not.toContain('终止');

    snapshot = {
      id: 'thread-1',
      turns: snapshot.turns.map((turn) =>
        turn.id === 'desktop-turn'
          ? externalTurn('desktop-turn', 'completed', 'desktop prompt', 'desktop answer')
          : turn,
      ),
    };
    nowMs += 3_000;
    await handle.runNow();
    nowMs += 100;
    await handle.runNow();
    const cardUpdates = channel.rawClient.requests.filter(
      (request) => request.method === 'cardkit.v1.card.update',
    );
    expect(cardUpdates).toHaveLength(1);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(cardUpdates[0])).toContain('desktop answer');
    await handle.stop();

    const secondReader = {
      readThread: vi.fn(async () => snapshot),
      stop: vi.fn(async () => undefined),
    };
    const restarted = await startCodexTurnSync({
      channel: channel as unknown as LarkChannel,
      controls,
      sessionCatalog,
      profileStateDir: dir,
      statePath,
      intervalMs: 60_000,
      reader: secondReader,
      now: () => nowMs,
    });
    await restarted.runNow();
    expect(channel.sent).toHaveLength(2);
    expect(channel.rawClient.requests.filter(
      (request) => request.method === 'cardkit.v1.card.update',
    )).toHaveLength(1);
    await restarted.stop();
  });

  it('replays only the configured recent completed turns into a newly attached AA group', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-sync-replay-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const entry = {
      key: 'entry-replay',
      scopeId: 'oc_replay',
      agentId: 'codex',
      cwdRealpath: dir,
      policyFingerprint: 'policy',
      status: 'active',
      updatedAt: 1,
      threadId: 'thread-replay',
      recentTurnReplayCount: 3,
    } satisfies SessionCatalogEntry;
    const snapshot: CodexThreadSnapshot = {
      id: 'thread-replay',
      turns: [
        externalTurn('turn-1', 'completed', 'prompt 1', 'answer 1'),
        externalTurn('turn-2', 'completed', 'prompt 2', 'answer 2'),
        externalTurn('turn-3', 'completed', 'prompt 3', 'answer 3'),
        externalTurn('turn-4', 'completed', 'prompt 4', 'answer 4'),
        bridgeTurn('bridge-turn'),
        externalTurn('turn-5', 'completed', 'prompt 5', 'answer 5'),
      ],
    };
    const sessionCatalog = new SessionCatalog(join(dir, 'catalog.json'));
    await sessionCatalog.replaceForTest([entry]);
    const handle = await startCodexTurnSync({
      channel: channel as unknown as LarkChannel,
      controls: controlsForCodex(),
      sessionCatalog,
      profileStateDir: dir,
      statePath: join(dir, 'sync-state.json'),
      intervalMs: 60_000,
      reader: {
        readThread: vi.fn(async () => snapshot),
        stop: vi.fn(async () => undefined),
      },
      now: () => 10_000,
    });

    await handle.runNow();

    expect(channel.sent).toHaveLength(6);
    const payload = JSON.stringify(channel.sent.map((message) => message.content));
    expect(payload).not.toContain('prompt 1');
    expect(payload).not.toContain('prompt 2');
    expect(payload).not.toContain('prompt 3');
    for (const value of ['prompt 4', 'answer 4', 'plain Feishu prompt', 'already delivered', 'prompt 5', 'answer 5']) {
      expect(payload).toContain(value);
    }
    expect(sessionCatalog.entries()[0]?.recentTurnReplayCount).toBeUndefined();
    await handle.runNow();
    expect(channel.sent).toHaveLength(6);
    await handle.stop();
  });

  it('keeps polling a replayed bridge turn until its mirrored card becomes terminal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-sync-bridge-running-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const entry = {
      key: 'entry-bridge-running',
      scopeId: 'oc_bridgerunning',
      agentId: 'codex',
      cwdRealpath: dir,
      policyFingerprint: 'policy',
      status: 'active',
      updatedAt: 1,
      threadId: 'thread-bridge-running',
      recentTurnReplayCount: 3,
    } satisfies SessionCatalogEntry;
    const sessionCatalog = new SessionCatalog(join(dir, 'catalog.json'));
    await sessionCatalog.replaceForTest([entry]);
    let snapshot: CodexThreadSnapshot = {
      id: 'thread-bridge-running',
      updatedAtMs: 9_500,
      turns: [{
        ...bridgeTurn('bridge-running'),
        status: 'interrupted',
        completedAtMs: null,
      }],
    };
    const reader = {
      readThread: vi.fn(async () => snapshot),
      listRecentThreads: vi.fn(async () => [{ id: snapshot.id, updatedAtMs: 1_000 }]),
      stop: vi.fn(async () => undefined),
    };
    const handle = await startCodexTurnSync({
      channel: channel as unknown as LarkChannel,
      controls: controlsForCodex(),
      sessionCatalog,
      profileStateDir: dir,
      statePath: join(dir, 'sync-state.json'),
      intervalMs: 60_000,
      reader,
      now: () => 10_000,
    });
    await handle.runNow();
    expect(channel.sent).toHaveLength(2);
    expect(JSON.stringify(channel.sent[1]?.content)).toContain('运行中');

    // The list watermark is intentionally unchanged, reproducing the race
    // where thread/list advances before thread/read exposes task_complete.
    snapshot = {
      id: snapshot.id,
      turns: [bridgeTurn('bridge-running')],
    };
    await handle.runNow();

    expect(reader.readThread).toHaveBeenCalledTimes(2);
    const updates = channel.rawClient.requests.filter(
      (request) => request.method === 'cardkit.v1.card.update',
    );
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates[0])).toContain('already delivered');
    await handle.stop();
  });

  it('does not mirror a raw prompt claimed by native codex queue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-sync-queue-claim-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const entry = {
      key: 'entry-queue-claim',
      scopeId: 'oc_queueclaim',
      agentId: 'codex',
      cwdRealpath: dir,
      policyFingerprint: 'policy',
      status: 'active',
      updatedAt: 1,
      threadId: 'thread-queue-claim',
    } satisfies SessionCatalogEntry;
    const sessionCatalog = { entries: () => [entry] } as unknown as SessionCatalog;
    let snapshot: CodexThreadSnapshot = {
      id: 'thread-queue-claim',
      turns: [externalTurn('old-turn-claim', 'completed', 'old prompt', 'old answer')],
    };
    const reader = {
      readThread: vi.fn(async () => snapshot),
      stop: vi.fn(async () => undefined),
    };
    const handle = await startCodexTurnSync({
      channel: channel as unknown as LarkChannel,
      controls: controlsForCodex(),
      sessionCatalog,
      profileStateDir: dir,
      statePath: join(dir, 'sync-state.json'),
      intervalMs: 60_000,
      reader,
      now: () => 20_000,
    });
    await handle.runNow();

    registerCodexQueuedTurnClaim(
      'lark-channel-bridge:queue-claim',
      'thread-queue-claim',
      '原样飞书消息',
      ['old-turn-claim'],
    );
    snapshot = {
      id: 'thread-queue-claim',
      turns: [
        ...snapshot.turns,
        externalTurn('native-queue-turn', 'inProgress', '原样飞书消息', ''),
      ],
    };
    await handle.runNow();

    expect(channel.sent).toHaveLength(0);
    await handle.stop();
  });

  it('revalidates and reopens a prematurely interrupted external turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-sync-reopen-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const entry = {
      key: 'entry-reopen',
      scopeId: 'oc_reopen',
      agentId: 'codex',
      cwdRealpath: dir,
      policyFingerprint: 'policy',
      status: 'active',
      updatedAt: 1,
      threadId: 'thread-reopen',
    } satisfies SessionCatalogEntry;
    const sessionCatalog = { entries: () => [entry] } as unknown as SessionCatalog;
    let nowMs = 30_000;
    let revision = 1_000;
    let snapshot: CodexThreadSnapshot = {
      id: 'thread-reopen',
      turns: [externalTurn('old-turn-reopen', 'completed', 'old prompt', 'old answer')],
    };
    const statePath = join(dir, 'sync-state.json');
    const reader = {
      readThread: vi.fn(async () => snapshot),
      listRecentThreads: vi.fn(async () => [{ id: snapshot.id, updatedAtMs: revision }]),
      stop: vi.fn(async () => undefined),
    };
    const handle = await startCodexTurnSync({
      channel: channel as unknown as LarkChannel,
      controls: controlsForCodex(),
      sessionCatalog,
      profileStateDir: dir,
      statePath,
      intervalMs: 60_000,
      reader,
      now: () => nowMs,
    });
    await handle.runNow();

    snapshot = {
      id: snapshot.id,
      turns: [
        ...snapshot.turns,
        externalTurn('desktop-reopen', 'interrupted', 'desktop prompt', ''),
      ],
    };
    revision = 2_000;
    nowMs += 3_000;
    await handle.runNow();
    expect(channel.sent).toHaveLength(2);
    expect(JSON.stringify(channel.sent[1]?.content)).toMatch(/已中断|已被中断/);
    await handle.stop();

    // Reproduce the production race: Codex reports the same turn as running,
    // while thread/list has not advanced beyond the persisted revision yet.
    snapshot = {
      id: snapshot.id,
      turns: snapshot.turns.map((turn) =>
        turn.id === 'desktop-reopen'
          ? externalTurn('desktop-reopen', 'inProgress', 'desktop prompt', '')
          : turn,
      ),
    };
    nowMs += 3_000;
    const restartedReader = {
      readThread: vi.fn(async () => snapshot),
      listRecentThreads: vi.fn(async () => [{ id: snapshot.id, updatedAtMs: revision }]),
      stop: vi.fn(async () => undefined),
    };
    const restarted = await startCodexTurnSync({
      channel: channel as unknown as LarkChannel,
      controls: controlsForCodex(),
      sessionCatalog,
      profileStateDir: dir,
      statePath,
      intervalMs: 60_000,
      reader: restartedReader,
      now: () => nowMs,
    });
    await restarted.runNow();

    const reopenedUpdates = channel.rawClient.requests.filter(
      (request) => request.method === 'cardkit.v1.card.update',
    );
    expect(restartedReader.readThread).toHaveBeenCalled();
    expect(reopenedUpdates).toHaveLength(1);
    expect(JSON.stringify(reopenedUpdates[0])).toContain('运行中');
    expect(JSON.stringify(reopenedUpdates[0])).not.toMatch(/已中断|已被中断/);

    snapshot = {
      id: snapshot.id,
      turns: snapshot.turns.map((turn) =>
        turn.id === 'desktop-reopen'
          ? externalTurn('desktop-reopen', 'completed', 'desktop prompt', 'desktop answer')
          : turn,
      ),
    };
    revision = 3_000;
    nowMs += 3_000;
    await restarted.runNow();
    const finalUpdates = channel.rawClient.requests.filter(
      (request) => request.method === 'cardkit.v1.card.update',
    );
    expect(finalUpdates).toHaveLength(2);
    expect(JSON.stringify(finalUpdates[1])).toContain('desktop answer');
    await restarted.stop();
  });

  it('keeps a recent unfinished tail turn running when the read-only server reports interrupted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-sync-provisional-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const entry = {
      key: 'entry-provisional',
      scopeId: 'oc_provisional',
      agentId: 'codex',
      cwdRealpath: dir,
      policyFingerprint: 'policy',
      status: 'active',
      updatedAt: 1,
      threadId: 'thread-provisional',
    } satisfies SessionCatalogEntry;
    const sessionCatalog = { entries: () => [entry] } as unknown as SessionCatalog;
    let nowMs = 100_000;
    let snapshot: CodexThreadSnapshot = {
      id: 'thread-provisional',
      updatedAtMs: nowMs,
      turns: [externalTurn('old-turn-provisional', 'completed', 'old prompt', 'old answer')],
    };
    const reader = {
      readThread: vi.fn(async () => snapshot),
      stop: vi.fn(async () => undefined),
    };
    const handle = await startCodexTurnSync({
      channel: channel as unknown as LarkChannel,
      controls: controlsForCodex(),
      sessionCatalog,
      profileStateDir: dir,
      statePath: join(dir, 'sync-state.json'),
      intervalMs: 60_000,
      reader,
      now: () => nowMs,
    });
    await handle.runNow();

    const provisional = externalTurn('desktop-provisional', 'interrupted', 'desktop prompt', '');
    provisional.completedAtMs = null;
    snapshot = {
      id: snapshot.id,
      updatedAtMs: nowMs,
      turns: [...snapshot.turns, provisional],
    };
    nowMs += 3_000;
    snapshot.updatedAtMs = nowMs;
    await handle.runNow();

    expect(channel.sent).toHaveLength(2);
    expect(JSON.stringify(channel.sent[1]?.content)).toContain('运行中');
    expect(JSON.stringify(channel.sent[1]?.content)).not.toMatch(/已中断|已被中断/);

    snapshot = {
      id: snapshot.id,
      updatedAtMs: nowMs,
      turns: snapshot.turns.map((turn) =>
        turn.id === 'desktop-provisional'
          ? externalTurn('desktop-provisional', 'completed', 'desktop prompt', 'desktop answer')
          : turn,
      ),
    };
    nowMs += 3_000;
    snapshot.updatedAtMs = nowMs;
    await handle.runNow();
    const updates = channel.rawClient.requests.filter(
      (request) => request.method === 'cardkit.v1.card.update',
    );
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates[0])).toContain('desktop answer');
    await handle.stop();
  });
});

function controlsForCodex(): Controls {
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    codex: { binaryPath: 'codex', inheritCodexHome: true },
  });
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'ok',
    configPath: 'unused.json',
    cfg: { preferences: {} },
    processId: 'test',
    knownChats: [],
    refreshOwner: vi.fn(),
    restart: vi.fn(),
    exit: vi.fn(),
  } as unknown as Controls;
}

function externalTurn(
  id: string,
  status: string,
  prompt: string,
  answer: string,
): CodexThreadSnapshot['turns'][number] {
  return {
    id,
    status,
    items: [
      { type: 'userMessage', id: `${id}-user`, content: [{ type: 'text', text: prompt }] },
      ...(answer ? [{ type: 'agentMessage', id: `${id}-answer`, text: answer }] : []),
    ],
  };
}

function bridgeTurn(id: string): CodexThreadSnapshot['turns'][number] {
  return {
    id,
    status: 'completed',
    items: [
      {
        type: 'userMessage',
        id: `${id}-user`,
        clientId: `lark-channel-bridge:${id}`,
        content: [{ type: 'text', text: 'plain Feishu prompt' }],
      },
      { type: 'agentMessage', id: `${id}-answer`, text: 'already delivered' },
    ],
  };
}
