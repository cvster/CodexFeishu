import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { SessionCatalog, SessionCatalogEntry } from '../../../src/session/catalog.js';
import type { CodexThreadSnapshot } from '../../../src/session/codex-thread-reader.js';
import { startCodexTurnSync } from '../../../src/bot/codex-turn-sync.js';
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
