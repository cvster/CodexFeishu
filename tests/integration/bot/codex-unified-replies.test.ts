import type { NormalizedMessage } from '@larksuite/channel';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const mock = vi.hoisted(() => ({ channel: undefined as unknown, observed: [] as string[], delivered: false,
  observeTurn: vi.fn(), runNow: vi.fn(), stop: vi.fn() }));
vi.mock('@larksuite/channel', async (original) => ({
  ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => mock.channel,
}));
vi.mock('../../../src/bot/aa-session-groups.js', () => ({ startAaSessionGroupSync: () => ({
  stop() {}, withPaused: async (operation: () => Promise<unknown>) => operation(),
}) }));
vi.mock('../../../src/bot/codex-turn-sync.js', () => ({ startCodexTurnSync: async () => ({
  observeTurn: mock.observeTurn, runNow: mock.runNow, stop: mock.stop, refreshMessage: async () => false,
}) }));

import { startChannel } from '../../../src/bot/channel.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
  mock.observed = [];
  mock.delivered = false;
});

describe('unified Codex reply owner', () => {
  it('submits raw input and leaves every answer to the synchronizer, even with CoT enabled', async () => {
    const h = await harness(false);
    await h.message();
    await vi.waitFor(() => expect(h.channel.sent).toHaveLength(1), { timeout: 3_000 });
    expect(mock.observeTurn).toHaveBeenCalledWith('oc_group', 'thread-one', 'turn-one', 'om_input', undefined);
    expect(h.channel.streams).toHaveLength(0);
    expect(mock.runNow).toHaveBeenCalledTimes(1);
    expect(h.agent.runOptions[0]?.prompt).toBe('原样输入');
    expect(JSON.stringify(h.channel.sent)).toContain('unified answer');
    expect(JSON.stringify(h.channel.sent)).not.toContain('legacy stream answer');
  });

  it('reports a rejected submission once when no Codex turn was created', async () => {
    const h = await harness(true);
    await h.message();
    await vi.waitFor(() => expect(h.channel.sent).toHaveLength(1), { timeout: 3_000 });
    expect(h.channel.streams).toHaveLength(0);
    expect(mock.observeTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(h.channel.sent)).toContain('消息提交失败');
    expect(JSON.stringify(h.channel.sent)).toContain('queue rejected');
  });
});

async function harness(fail: boolean) {
  const tmp = await createTmpProfile('codex-unified-output-');
  cleanups.push(() => tmp.cleanup());
  const channel = createFakeChannel();
  const handlers: { message?: (message: NormalizedMessage) => Promise<void> } = {};
  mock.channel = Object.assign(channel, {
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    connect: async () => {}, disconnect: async () => {},
    on: (next: typeof handlers) => Object.assign(handlers, next),
    getChatMode: async () => 'group',
    getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }),
    listChats: async () => [], getChatInfo: async () => ({ name: 'test' }),
    addReaction: async () => 'reaction', removeReaction: async () => {},
  });
  mock.observeTurn.mockImplementation((_scope: string, _thread: string, turn: string) => mock.observed.push(turn));
  mock.runNow.mockImplementation(async () => {
    if (!mock.observed.length || mock.delivered) return;
    mock.delivered = true;
    await channel.send('oc_group', { markdown: 'unified answer' });
  });
  mock.stop.mockResolvedValue(undefined);
  const profileConfig = createDefaultProfileConfig({ agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' }, access: { allowedUsers: ['ou_user'], allowedChats: ['oc_group'] },
    preferences: { cotMessages: 'brief', messageReply: 'card' },
  });
  profileConfig.workspaces.default = tmp.workspace;
  const controls = { profile: 'codex', profileConfig, cfg: profileConfig,
    ownerRefreshState: 'ok', botOwnerId: 'ou_user', knownChats: [{ id: 'oc_group', name: 'test' }],
    refreshOwner: async () => {}, restart: async () => {}, exit: async () => {},
    configPath: join(tmp.profile, 'config.json'), processId: 'test',
  } as unknown as Controls;
  const agent = new FakeAgentAdapter({ id: 'codex', events: fail
    ? [{ type: 'error', message: 'queue rejected', terminationReason: 'failed' }]
    : [{ type: 'system', threadId: 'thread-one' },
       { type: 'system', threadId: 'thread-one', turnId: 'turn-one' },
       { type: 'text', delta: 'legacy stream answer' }, { type: 'done', threadId: 'thread-one', terminationReason: 'normal' }] });
  const bridge = await startChannel({ cfg: profileConfig, controls, agent,
    sessions: new SessionStore(join(tmp.profile, 'sessions.json')),
    sessionCatalog: new SessionCatalog(join(tmp.profile, 'catalog.json')),
    workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')),
    appPaths: { profileDir: tmp.profile, mediaDir: join(tmp.profile, 'media'),
      secretsFile: join(tmp.profile, 'secrets.enc'), keystoreSaltFile: join(tmp.profile, '.salt') },
  });
  expect(controls.codexReplySync).toBeDefined();
  cleanups.push(() => bridge.disconnect());
  return { channel, agent, message: () => handlers.message?.({ messageId: 'om_input', chatId: 'oc_group',
    chatType: 'group', senderId: 'ou_user', senderName: 'User', content: '原样输入',
    rawContentType: 'text', resources: [], mentionedBot: true, createTime: Date.now(),
    mentions: [], mentionAll: false,
  } as NormalizedMessage) };
}
