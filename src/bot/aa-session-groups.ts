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
import type { SessionCatalog, SessionCatalogEntry } from '../session/catalog';
import { listCodexThreadHistory, type CodexThreadHistoryEntry } from '../session/codex-history';
import type { WorkspaceStore } from '../workspace/store';
import { createBoundChat, renameChat } from './group';
import { fetchKnownChatsResult, type KnownChat } from './lark-info';

const DEFAULT_SYNC_INTERVAL_MS = 60_000;
const HISTORY_LIMIT = 10_000;
const AA_RECENT_TURN_REPLAY_COUNT = 3;

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
  // Chat visibility is scoped by the credentials on this channel. Fetch it before
  // trusting catalog bindings so entries left by another bot cannot suppress group creation.
  const knownChatsResult = await fetchKnownChatsResult(deps.channel);
  if (!knownChatsResult.ok) {
    log.warn('aa-session-groups', 'sync-skipped-chat-list-unavailable');
    return;
  }
  deps.controls.knownChats = knownChatsResult.chats;
  const knownChatIds = new Set(knownChatsResult.chats.map((chat) => chat.id));
  const currentBotAppId = deps.controls.profileConfig.accounts.app.id;
  const catalogEntries = deps.sessionCatalog.entries();
  const boundThreadIds = new Set(
    catalogEntries
      .filter((entry) =>
        isCurrentBotBinding(entry, currentBotAppId, knownChatIds) && entry.threadId,
      )
      .map((entry) => entry.threadId as string),
  );
  const candidates = latestVersionSessions(history).filter(
    (thread) => isAaSession(thread) && !boundThreadIds.has(thread.threadId),
  );
  if (candidates.length === 0) return;

  const usedNames = new Set(knownChatsResult.chats.map((chat) => chat.name.trim()));
  const historyByThreadId = new Map(history.map((thread) => [thread.threadId, thread]));

  for (const thread of candidates) {
    // Another timer/manual action may have bound it while this sync was awaiting I/O.
    if (deps.sessionCatalog.entries().some(
      (entry) =>
        entry.threadId === thread.threadId &&
        isCurrentBotBinding(entry, currentBotAppId, knownChatIds),
    )) continue;

    const workspace = await resolveWorkingDirectory(thread.cwd);
    if (!workspace.ok) {
      log.warn('aa-session-groups', 'invalid-workspace', {
        threadId: thread.threadId,
        cwd: thread.cwd,
      });
      continue;
    }
    const previous = findPreviousVersionBinding(
      thread,
      deps.sessionCatalog.entries(),
      historyByThreadId,
      currentBotAppId,
      knownChatIds,
    );
    if (previous) {
      const oldChat: KnownChat | undefined = deps.controls.knownChats?.find(
        (chat) => chat.id === previous.scopeId,
      );
      const namesWithoutCurrent = new Set(usedNames);
      if (oldChat?.name) namesWithoutCurrent.delete(oldChat.name.trim());
      const name = uniqueGroupName(thread.name!, namesWithoutCurrent);
      const access = canUseGroup(
        deps.controls.profileConfig,
        deps.controls,
        previous.scopeId,
        actorId,
      );
      const policy = evaluateRunPolicy({
        scope: { source: 'im', chatId: previous.scopeId, actorId },
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
        log.warn('aa-session-groups', 'policy-denied-before-upgrade', {
          chatId: previous.scopeId,
          threadId: thread.threadId,
        });
        continue;
      }
      try {
        if (oldChat?.name.trim() !== name) {
          await renameChat(deps.channel, previous.scopeId, name);
        }
        deps.sessionCatalog.archiveActive(previous);
        deps.sessionCatalog.archiveThread(thread.threadId);
        deps.sessionCatalog.upsertActive({
          scopeId: previous.scopeId,
          agentId: 'codex',
          cwdRealpath: workspace.cwdRealpath,
          policyFingerprint: policy.policyFingerprint,
          threadId: thread.threadId,
          botAppId: currentBotAppId,
          recentTurnReplayCount: null,
        });
        deps.workspaces.setCwd(previous.scopeId, workspace.cwdRealpath);
        await Promise.all([deps.workspaces.flush(), deps.sessionCatalog.flush()]);
        await persistAllowedChat(deps.controls, previous.scopeId);
      } catch (err) {
        log.fail('aa-session-groups', err, {
          step: 'upgrade-chat',
          chatId: previous.scopeId,
          threadId: thread.threadId,
        });
        continue;
      }
      if (oldChat?.name) usedNames.delete(oldChat.name.trim());
      usedNames.add(name);
      deps.controls.knownChats = [
        ...(deps.controls.knownChats ?? []).filter((chat) => chat.id !== previous.scopeId),
        { id: previous.scopeId, name },
      ];
      boundThreadIds.add(thread.threadId);
      await sendManagedCard(
        deps.channel,
        previous.scopeId,
        newChatWorkspaceCard(name, { threadId: thread.threadId, existing: true }),
      ).catch((err) => log.warn('aa-session-groups', 'upgrade-welcome-failed', {
        chatId: previous.scopeId,
        err: errorText(err),
      }));
      log.info('aa-session-groups', 'upgraded', {
        chatId: previous.scopeId,
        fromThreadId: previous.threadId,
        threadId: thread.threadId,
        name,
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
    // Retire bindings for this thread that belonged to a previous bot before
    // recording the newly created group for the authenticated bot.
    deps.sessionCatalog.archiveThread(thread.threadId);
    deps.sessionCatalog.upsertActive({
      scopeId: created.chatId,
      agentId: 'codex',
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
      threadId: thread.threadId,
      botAppId: currentBotAppId,
      recentTurnReplayCount: AA_RECENT_TURN_REPLAY_COUNT,
    });
    await Promise.all([deps.workspaces.flush(), deps.sessionCatalog.flush()]);
    await persistAllowedChat(deps.controls, created.chatId).catch((err) =>
      log.fail('aa-session-groups', err, { step: 'allow-chat', chatId: created.chatId }),
    );
    deps.controls.knownChats = [
      ...(deps.controls.knownChats ?? []).filter((chat) => chat.id !== created.chatId),
      { id: created.chatId, name: created.name },
    ];
    knownChatIds.add(created.chatId);
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

function isCurrentBotBinding(
  entry: SessionCatalogEntry,
  currentBotAppId: string,
  knownChatIds: Set<string>,
): boolean {
  if (entry.status !== 'active' || entry.agentId !== 'codex') return false;
  if (!knownChatIds.has(entry.scopeId)) return false;
  return !entry.botAppId || entry.botAppId === currentBotAppId;
}

export function isAaSession(thread: CodexThreadHistoryEntry): boolean {
  return Boolean(thread.name?.trimStart().startsWith('AA'));
}

export interface AaSessionVersion {
  family: string;
  version?: number;
}

export function aaSessionVersion(name: string): AaSessionVersion {
  const normalized = normalizeTitle(name);
  const match = /^(.*?)(\d{1,2})$/u.exec(normalized);
  const family = match?.[1]?.trimEnd();
  if (!match || !family) return { family: normalized };
  return { family, version: Number.parseInt(match[2]!, 10) };
}

function latestVersionSessions(history: CodexThreadHistoryEntry[]): CodexThreadHistoryEntry[] {
  const latest = new Map<string, CodexThreadHistoryEntry>();
  for (const thread of history) {
    if (!isAaSession(thread) || !thread.name) continue;
    const parsed = aaSessionVersion(thread.name);
    if (parsed.version === undefined) {
      latest.set(`thread:${thread.threadId}`, thread);
      continue;
    }
    const key = `family:${parsed.family}`;
    const current = latest.get(key);
    if (!current || isNewerVersion(thread, current)) latest.set(key, thread);
  }
  return [...latest.values()];
}

function isNewerVersion(
  candidate: CodexThreadHistoryEntry,
  current: CodexThreadHistoryEntry,
): boolean {
  const candidateVersion = aaSessionVersion(candidate.name ?? '').version ?? -1;
  const currentVersion = aaSessionVersion(current.name ?? '').version ?? -1;
  if (candidateVersion !== currentVersion) return candidateVersion > currentVersion;
  return candidate.updatedAtMs > current.updatedAtMs;
}

function findPreviousVersionBinding(
  target: CodexThreadHistoryEntry,
  entries: SessionCatalogEntry[],
  historyByThreadId: Map<string, CodexThreadHistoryEntry>,
  currentBotAppId: string,
  knownChatIds: Set<string>,
): SessionCatalogEntry | undefined {
  if (!target.name) return undefined;
  const targetVersion = aaSessionVersion(target.name);
  if (targetVersion.version === undefined) return undefined;
  return entries
    .filter((entry) => {
      if (!entry.threadId || !isCurrentBotBinding(entry, currentBotAppId, knownChatIds)) return false;
      const previous = historyByThreadId.get(entry.threadId);
      if (!previous?.name) return false;
      const previousVersion = aaSessionVersion(previous.name);
      return previousVersion.family === targetVersion.family &&
        previousVersion.version !== undefined &&
        previousVersion.version < targetVersion.version!;
    })
    .sort((a, b) => {
      const aVersion = aaSessionVersion(historyByThreadId.get(a.threadId!)?.name ?? '').version ?? -1;
      const bVersion = aaSessionVersion(historyByThreadId.get(b.threadId!)?.name ?? '').version ?? -1;
      return bVersion - aVersion || b.updatedAt - a.updatedAt;
    })[0];
}

function concreteInviteOpenIds(controls: Controls): string[] {
  return [...new Set([
    ...(controls.botOwnerId ? [controls.botOwnerId] : []),
    ...controls.profileConfig.access.admins,
  ].filter((id) => /^ou_[A-Za-z0-9]+$/.test(id)))];
}

function uniqueGroupName(title: string, usedNames: Set<string>): string {
  const base = normalizeTitle(title).slice(0, 48) || 'AA Codex会话';
  if (!usedNames.has(base)) return base;
  let suffix = 2;
  while (usedNames.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function normalizeTitle(title: string): string {
  return title.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
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
