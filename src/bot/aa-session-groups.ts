import type { LarkChannel } from '@larksuite/channel';
import { codexCapability } from '../agent/capability';
import { sendManagedCard } from '../card/managed';
import { newChatWorkspaceCard } from '../card/templates';
import { loadRootConfig, runtimeProfileConfig, saveRootConfig, withConfigFileLock } from '../config/profile-store';
import type { Controls } from '../commands';
import { log } from '../core/logger';
import { canUseGroup } from '../policy/access';
import { evaluateRunPolicy } from '../policy/run-policy';
import { resolveWorkingDirectory } from '../policy/workspace';
import type { SessionCatalog } from '../session/catalog';
import { listCodexThreadHistory, type CodexThreadHistoryEntry } from '../session/codex-history';
import type { WorkspaceStore } from '../workspace/store';
import { createBoundChat } from './group';
import { fetchKnownChats } from './lark-info';

const DEFAULT_SYNC_INTERVAL_MS = 60_000;
const HISTORY_LIMIT = 10_000;

export interface AaSessionGroupSyncDeps {
  channel: LarkChannel;
  controls: Controls;
  sessionCatalog: SessionCatalog;
  workspaces: WorkspaceStore;
  profileStateDir: string;
  intervalMs?: number;
  historyProvider?: typeof listCodexThreadHistory;
}

export interface AaSessionGroupSyncHandle {
  runNow(): Promise<void>;
  stop(): void;
}

export function startAaSessionGroupSync(deps: AaSessionGroupSyncDeps): AaSessionGroupSyncHandle {
  let stopped = false;
  let running: Promise<void> | undefined;
  const runNow = async (): Promise<void> => {
    if (stopped) return;
    if (running) return running;
    running = syncAaSessionGroupsOnce(deps)
      .catch((err) => log.fail('aa-session-groups', err, { step: 'sync' }))
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  void runNow();
  const timer = setInterval(() => void runNow(), deps.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS);
  timer.unref?.();
  return {
    runNow,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function syncAaSessionGroupsOnce(deps: AaSessionGroupSyncDeps): Promise<void> {
  const codex = deps.controls.profileConfig.codex;
  if (deps.controls.profileConfig.agentKind !== 'codex' || !codex?.binaryPath) return;

  const inviteOpenIds = concreteInviteOpenIds(deps.controls);
  const actorId = deps.controls.botOwnerId ?? inviteOpenIds[0];
  if (!actorId || inviteOpenIds.length === 0) {
    log.warn('aa-session-groups', 'missing-invite-user', {
      ownerRefreshState: deps.controls.ownerRefreshState,
    });
    return;
  }

  const historyProvider = deps.historyProvider ?? listCodexThreadHistory;
  const history = await historyProvider({
    binary: codex.binaryPath,
    limit: HISTORY_LIMIT,
    timeoutMs: 60_000,
    profileStateDir: deps.profileStateDir,
    ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
    ...(codex.inheritCodexHome !== undefined
      ? { inheritCodexHome: codex.inheritCodexHome }
      : {}),
  });
  const boundThreadIds = new Set(
    deps.sessionCatalog.entries()
      .filter((entry) => entry.status === 'active' && entry.agentId === 'codex' && entry.threadId)
      .map((entry) => entry.threadId as string),
  );
  const candidates = history.filter(
    (thread) => isAaSession(thread) && !boundThreadIds.has(thread.threadId),
  );
  if (candidates.length === 0) return;

  const knownChats = await fetchKnownChats(deps.channel);
  if (knownChats.length > 0) deps.controls.knownChats = knownChats;
  const usedNames = new Set((deps.controls.knownChats ?? []).map((chat) => chat.name.trim()));

  for (const thread of candidates) {
    // Another timer/manual action may have bound it while this sync was awaiting I/O.
    if (deps.sessionCatalog.entries().some(
      (entry) => entry.status === 'active' && entry.agentId === 'codex' && entry.threadId === thread.threadId,
    )) continue;

    const workspace = await resolveWorkingDirectory(thread.cwd);
    if (!workspace.ok) {
      log.warn('aa-session-groups', 'invalid-workspace', {
        threadId: thread.threadId,
        cwd: thread.cwd,
      });
      continue;
    }
    const name = uniqueGroupName(thread.name!, usedNames);
    let created;
    try {
      created = await createBoundChat({
        channel: deps.channel,
        name,
        inviteOpenIds,
        description: `自动绑定 Codex 会话 ${thread.threadId}`,
      });
    } catch (err) {
      log.fail('aa-session-groups', err, { step: 'create-chat', threadId: thread.threadId });
      continue;
    }

    deps.workspaces.setCwd(created.chatId, workspace.cwdRealpath);
    const access = canUseGroup(
      deps.controls.profileConfig,
      deps.controls,
      created.chatId,
      actorId,
    );
    const policy = evaluateRunPolicy({
      scope: { source: 'im', chatId: created.chatId, actorId },
      attachments: [],
      prompt: '',
      requestedCwd: workspace.cwdRealpath,
      cwdRealpath: workspace.cwdRealpath,
      access,
      capability: codexCapability(deps.controls.profileConfig),
      profileConfig: deps.controls.profileConfig,
      now: Date.now(),
      codexHome: codex.codexHome,
      inheritCodexHome: codex.inheritCodexHome,
    });
    if (!policy.ok) {
      log.warn('aa-session-groups', 'policy-denied-after-create', {
        chatId: created.chatId,
        threadId: thread.threadId,
      });
      continue;
    }
    deps.sessionCatalog.upsertActive({
      scopeId: created.chatId,
      agentId: 'codex',
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
      threadId: thread.threadId,
    });
    await Promise.all([deps.workspaces.flush(), deps.sessionCatalog.flush()]);
    await persistAllowedChat(deps.controls, created.chatId).catch((err) =>
      log.fail('aa-session-groups', err, { step: 'allow-chat', chatId: created.chatId }),
    );
    deps.controls.knownChats = [
      ...(deps.controls.knownChats ?? []).filter((chat) => chat.id !== created.chatId),
      { id: created.chatId, name: created.name },
    ];
    usedNames.add(created.name);
    boundThreadIds.add(thread.threadId);
    await sendManagedCard(
      deps.channel,
      created.chatId,
      newChatWorkspaceCard(created.name, { threadId: thread.threadId, existing: true }),
    ).catch((err) => log.warn('aa-session-groups', 'welcome-failed', {
      chatId: created.chatId,
      err: errorText(err),
    }));
    log.info('aa-session-groups', 'created', {
      chatId: created.chatId,
      threadId: thread.threadId,
      name: created.name,
    });
  }
}

export function isAaSession(thread: CodexThreadHistoryEntry): boolean {
  return Boolean(thread.name?.trimStart().startsWith('AA'));
}

function concreteInviteOpenIds(controls: Controls): string[] {
  return [...new Set([
    ...(controls.botOwnerId ? [controls.botOwnerId] : []),
    ...controls.profileConfig.access.admins,
  ].filter((id) => /^ou_[A-Za-z0-9]+$/.test(id)))];
}

function uniqueGroupName(title: string, usedNames: Set<string>): string {
  const base = title.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48) || 'AA Codex会话';
  if (!usedNames.has(base)) return base;
  let suffix = 2;
  while (usedNames.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

async function persistAllowedChat(controls: Controls, chatId: string): Promise<void> {
  if (controls.profileConfig.access.allowedChats.includes('*') ||
      controls.profileConfig.access.allowedChats.includes(chatId)) return;
  await withConfigFileLock(controls.configPath, async () => {
    const root = await loadRootConfig(controls.configPath);
    if (!root) throw new Error('profile config is not initialized');
    const profile = root.profiles[controls.profile];
    if (!profile) throw new Error(`profile not found: ${controls.profile}`);
    root.profiles[controls.profile] = {
      ...profile,
      access: {
        ...profile.access,
        allowedChats: [...new Set([...profile.access.allowedChats, chatId])],
      },
    };
    await saveRootConfig(root, controls.configPath);
    controls.profileConfig = root.profiles[controls.profile]!;
    controls.cfg = runtimeProfileConfig(root, controls.profile);
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
