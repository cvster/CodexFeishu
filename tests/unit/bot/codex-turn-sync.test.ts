import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

  it('mirrors external turns, skips historical turns, and resumes without duplicates', async () => {
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
      turns: [externalTurn('old-turn', 'completed', 'old prompt', 'old answer'), bridgeTurn('bridge-turn')],
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
    expect(JSON.stringify(channel.sent[1]?.content)).toContain(`项目 ${basename(dir)}`);
    expect(JSON.stringify(channel.sent[1]?.content)).not.toContain('"content":"终止"');

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
    expect(JSON.stringify(cardUpdates[0])).toContain(`项目 ${basename(dir)}`);
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
    // Completed cards remain refreshable after a bridge restart. Refreshes
    // must reuse the original message/card and serialize their stored sequence.
    expect(await restarted.refreshMessage('oc_other', 'om_fake_2')).toBe(false);
    expect(await restarted.refreshMessage('oc_group', 'om_unknown')).toBe(false);
    expect(await Promise.all([
      restarted.refreshMessage('oc_group', 'om_fake_2'),
      restarted.refreshMessage('oc_group', 'om_fake_2'),
    ])).toEqual([true, true]);
    await restarted.runNow();
    expect(channel.sent).toHaveLength(2);
    const refreshedUpdates = channel.rawClient.requests.filter(
      (request) => request.method === 'cardkit.v1.card.update',
    );
    expect(refreshedUpdates.map((request) => (request.params as { sequence: number }).sequence))
      .toEqual([2, 3, 4]);
    updateSpy.mockRejectedValueOnce(new Error('refresh transient'));
    await expect(restarted.refreshMessage('oc_group', 'om_fake_2')).rejects.toThrow('refresh transient');
    expect(await restarted.refreshMessage('oc_group', 'om_fake_2')).toBe(true);
    expect(channel.sent).toHaveLength(2);
    expect(channel.rawClient.requests.at(-1)).toMatchObject({
      method: 'cardkit.v1.card.update', params: { sequence: 6 },
    });
    await restarted.stop();
    expect(await restarted.refreshMessage('oc_group', 'om_fake_2')).toBe(false);
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

  it('delivers a raw native queue turn once without echoing its Feishu input', async () => {
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

    expect(channel.sent).toHaveLength(1);
    expect(channel.streams).toHaveLength(0);
    expect(JSON.stringify(channel.sent)).not.toContain('原样飞书消息');
    await handle.stop();
  });

  it('reuses one card when an initially empty turn later hydrates as bridge-origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-unified-empty-turn-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const entry = { key: 'entry', scopeId: 'oc_group', agentId: 'codex', cwdRealpath: dir,
      policyFingerprint: 'policy', status: 'active', updatedAt: 1, threadId: 'thread-empty' } satisfies SessionCatalogEntry;
    let snapshot: CodexThreadSnapshot = { id: entry.threadId, turns: [] };
    let nowMs = 10_000;
    const reader = { readThread: vi.fn(async () => snapshot), stop: vi.fn(async () => {}) };
    const deps = { channel: channel as unknown as LarkChannel, controls: controlsForCodex(),
      sessionCatalog: { entries: () => [entry] } as unknown as SessionCatalog,
      profileStateDir: dir, intervalMs: 60_000, reader, now: () => nowMs };
    const handle = await startCodexTurnSync(deps);
    await handle.runNow();
    registerCodexQueuedTurnClaim('lark-channel-bridge:late-user', entry.threadId, '迟到的输入', []);
    snapshot = { id: entry.threadId, turns: [{ id: 'turn-late', status: 'inProgress', items: [] }] };
    await handle.runNow();
    expect(channel.sent).toHaveLength(1);
    snapshot = { id: entry.threadId, turns: [externalTurn('turn-late', 'inProgress', '迟到的输入', 'partial')] };
    handle.observeTurn(entry.scopeId, entry.threadId, 'turn-late', 'om_input');
    await handle.runNow();
    snapshot = { id: entry.threadId, turns: [externalTurn('turn-late', 'completed', '迟到的输入', 'final answer')] };
    nowMs += 2_000;
    await handle.runNow();
    expect(channel.sent).toHaveLength(1);
    expect(JSON.stringify(channel.sent)).not.toContain('迟到的输入');
    expect(JSON.stringify(channel.rawClient.requests.at(-1))).toContain('final answer');
    await handle.stop();
    const restarted = await startCodexTurnSync(deps);
    await restarted.runNow();
    expect(channel.sent).toHaveLength(1);
    expect(await restarted.refreshMessage(entry.scopeId, 'om_fake_1')).toBe(true);
    expect(channel.sent).toHaveLength(1);
    await restarted.stop();
  });

  it('delivers an explicitly submitted fast first turn even if initially seen as completed history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-unified-fast-turn-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const entry = { key: 'entry', scopeId: 'oc_fast', agentId: 'codex', cwdRealpath: dir,
      policyFingerprint: 'policy', status: 'active', updatedAt: 1, threadId: 'thread-fast' } satisfies SessionCatalogEntry;
    const snapshot: CodexThreadSnapshot = { id: entry.threadId, turns: [bridgeTurn('fast')] };
    const reader = { readThread: vi.fn(async () => snapshot),
      listRecentThreads: vi.fn(async () => [{ id: entry.threadId, updatedAtMs: 1 }]), stop: vi.fn(async () => {}) };
    const handle = await startCodexTurnSync({ channel: channel as unknown as LarkChannel,
      controls: controlsForCodex(), sessionCatalog: { entries: () => [entry] } as unknown as SessionCatalog,
      profileStateDir: dir, intervalMs: 60_000, reader });
    await handle.runNow();
    expect(channel.sent).toHaveLength(0);
    handle.observeTurn(entry.scopeId, entry.threadId, 'fast', 'om_trigger', true);
    await handle.runNow();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.options).toEqual({ replyTo: 'om_trigger', replyInThread: true });
    handle.observeTurn(entry.scopeId, entry.threadId, 'fast', 'om_trigger', true);
    await handle.runNow();
    expect(channel.sent).toHaveLength(1);
    await handle.stop();
  });

  it('upgrades old state without replaying streaming replies and retains existing cards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-unified-migration-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const entry = { key: 'entry', scopeId: 'oc_migrate', agentId: 'codex', cwdRealpath: dir,
      policyFingerprint: 'policy', status: 'active', updatedAt: 1, threadId: 'thread-migrate' } satisfies SessionCatalogEntry;
    const statePath = join(dir, 'codex-turn-sync.json');
    await writeFile(statePath, JSON.stringify({ version: 1, threads: { [entry.threadId]: {
      bindings: [entry.scopeId], turnOrder: ['old'], turns: {
        old: { origin: 'bridge', discoveredAtMs: 1, deliveries: {} },
      },
    } } }));
    let snapshot: CodexThreadSnapshot = { id: entry.threadId, turns: [bridgeTurn('old')] };
    const handle = await startCodexTurnSync({ channel: channel as unknown as LarkChannel,
      controls: controlsForCodex(), sessionCatalog: { entries: () => [entry] } as unknown as SessionCatalog,
      profileStateDir: dir, intervalMs: 60_000,
      reader: { readThread: vi.fn(async () => snapshot), stop: vi.fn(async () => {}) } });
    await handle.runNow();
    expect(channel.sent).toHaveLength(0);
    snapshot = { id: entry.threadId, turns: [...snapshot.turns, bridgeTurn('new')] };
    await handle.runNow();
    expect(channel.sent).toHaveLength(1);
    await handle.stop();
    expect(JSON.parse(await readFile(statePath, 'utf8')).version).toBe(2);
  });

  it('finds fast Desktop turns under an unchanged list watermark and catches the final item tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-unified-watermark-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const entry = { key: 'entry', scopeId: 'oc_watermark', agentId: 'codex', cwdRealpath: dir,
      policyFingerprint: 'policy', status: 'active', updatedAt: 1, threadId: 'thread-watermark' } satisfies SessionCatalogEntry;
    let snapshot: CodexThreadSnapshot = { id: entry.threadId, turns: [] };
    let nowMs = 10_000;
    const reader = { readThread: vi.fn(async () => snapshot),
      listRecentThreads: vi.fn(async () => [{ id: entry.threadId, updatedAtMs: 1 }]), stop: vi.fn(async () => {}) };
    const handle = await startCodexTurnSync({ channel: channel as unknown as LarkChannel,
      controls: controlsForCodex(), sessionCatalog: { entries: () => [entry] } as unknown as SessionCatalog,
      profileStateDir: dir, intervalMs: 60_000, reader, now: () => nowMs });
    await handle.runNow();
    snapshot = { id: entry.threadId, turns: [externalTurn('quick', 'completed', 'desktop input', 'partial tail')] };
    await handle.runNow();
    expect(channel.sent).toHaveLength(2);
    snapshot = { id: entry.threadId, turns: [externalTurn('quick', 'completed', 'desktop input', 'complete final tail')] };
    await handle.runNow();
    expect(channel.sent).toHaveLength(2);
    expect(JSON.stringify(channel.rawClient.requests.at(-1))).toContain('complete final tail');
    const updateCount = channel.rawClient.requests.filter((request) => request.method === 'cardkit.v1.card.update').length;
    nowMs += 61_000;
    snapshot.turns[0]!.model = 'later projection model';
    await handle.runNow();
    expect(channel.rawClient.requests.filter((request) => request.method === 'cardkit.v1.card.update')).toHaveLength(updateCount);
    expect(await handle.refreshMessage(entry.scopeId, 'om_fake_2')).toBe(true);
    expect(JSON.stringify(channel.rawClient.requests.at(-1))).toContain('later projection model');
    await handle.stop();
  });

  it('does not replay pruned historical turns when the transcript exceeds its cursor limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-unified-pruned-history-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const entry = { key: 'entry', scopeId: 'oc_long', agentId: 'codex', cwdRealpath: dir,
      policyFingerprint: 'policy', status: 'active', updatedAt: 1, threadId: 'thread-long' } satisfies SessionCatalogEntry;
    const snapshot: CodexThreadSnapshot = { id: entry.threadId,
      turns: Array.from({ length: 320 }, (_, index) => bridgeTurn(`old-${index}`)) };
    const handle = await startCodexTurnSync({ channel: channel as unknown as LarkChannel,
      controls: controlsForCodex(), sessionCatalog: { entries: () => [entry] } as unknown as SessionCatalog,
      profileStateDir: dir, intervalMs: 60_000,
      reader: { readThread: vi.fn(async () => snapshot), stop: vi.fn(async () => {}) } });
    await handle.runNow();
    await handle.runNow();
    expect(channel.sent).toHaveLength(0);
    snapshot.turns.push(bridgeTurn('newest'));
    await handle.runNow();
    await handle.runNow();
    expect(channel.sent).toHaveLength(1);
    await handle.stop();
  });

  it('keeps plain-text preference terminal-only without invoking the legacy writer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-unified-text-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const controls = controlsForCodex();
    controls.cfg.preferences = { messageReply: 'text', messageReplyMigrated: true };
    const entry = { key: 'entry', scopeId: 'oc_text', agentId: 'codex', cwdRealpath: dir,
      policyFingerprint: 'policy', status: 'active', updatedAt: 1, threadId: 'thread-text' } satisfies SessionCatalogEntry;
    let snapshot: CodexThreadSnapshot = { id: entry.threadId, turns: [] };
    const handle = await startCodexTurnSync({ channel: channel as unknown as LarkChannel, controls,
      sessionCatalog: { entries: () => [entry] } as unknown as SessionCatalog,
      profileStateDir: dir, intervalMs: 60_000,
      reader: { readThread: vi.fn(async () => snapshot), stop: vi.fn(async () => {}) } });
    await handle.runNow();
    snapshot = { id: entry.threadId, turns: [{ ...bridgeTurn('text-turn'), status: 'inProgress' }] };
    handle.observeTurn(entry.scopeId, entry.threadId, 'text-turn', 'om_input');
    await handle.runNow();
    expect(channel.sent).toHaveLength(0);
    snapshot = { id: entry.threadId, turns: [bridgeTurn('text-turn')] };
    await handle.runNow();
    await handle.runNow();
    expect(channel.sent).toHaveLength(1);
    expect(JSON.stringify(channel.sent[0]?.content)).toContain('already delivered');
    expect(channel.streams).toHaveLength(0);
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

  it('refreshes through app-server before sealing a rollout-confirmed completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-sync-terminal-refresh-'));
    cleanup.push(dir);
    const channel = createFakeChannel();
    const entry = {
      key: 'entry-terminal-refresh',
      scopeId: 'oc_terminalrefresh',
      agentId: 'codex',
      cwdRealpath: dir,
      policyFingerprint: 'policy',
      status: 'active',
      updatedAt: 1,
      threadId: 'thread-terminal-refresh',
    } satisfies SessionCatalogEntry;
    const sessionCatalog = { entries: () => [entry] } as unknown as SessionCatalog;
    const baseline: CodexThreadSnapshot = {
      id: entry.threadId,
      turns: [externalTurn('old-terminal-refresh', 'completed', 'old prompt', 'old answer')],
    };
    const projected: CodexThreadSnapshot = {
      id: entry.threadId,
      rolloutPath: join(dir, 'rollout.jsonl'),
      turns: [
        ...baseline.turns,
        externalTurn('desktop-terminal-refresh', 'interrupted', 'desktop prompt', ''),
      ],
    };
    const refreshed: CodexThreadSnapshot = {
      ...projected,
      turns: projected.turns.map((turn) =>
        turn.id === 'desktop-terminal-refresh'
          ? externalTurn(
              'desktop-terminal-refresh',
              'completed',
              'desktop prompt',
              'complete desktop answer',
            )
          : turn,
      ),
    };
    const pending = [baseline, projected, refreshed];
    const reader = {
      readThread: vi.fn(async () => pending.shift() ?? refreshed),
      persistedTurnTerminal: vi.fn(async () => 'completed' as const),
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
      now: () => 200_000,
    });

    await handle.runNow();
    await handle.runNow();

    expect(reader.readThread).toHaveBeenCalledTimes(3);
    expect(channel.sent).toHaveLength(2);
    expect(JSON.stringify(channel.sent[1]?.content)).toContain('complete desktop answer');
    expect(JSON.stringify(channel.sent[1]?.content)).toContain('已完成');
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
