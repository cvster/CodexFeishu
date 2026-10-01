import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { SessionCatalog, SessionCatalogEntry } from '../session/catalog';
import {
  isClaimedCodexBridgeTurn,
  isCodexBridgeClientMessageId,
} from '../session/codex-origin';
import {
  CodexThreadReader,
  type CodexThreadReaderOptions,
  type CodexThreadRevision,
  type CodexThreadSnapshot,
  type CodexThreadTurn,
} from '../session/codex-thread-reader';
import {
  isInterruptedTurnStatus,
  isProvisionalInterruptedTurn,
} from '../session/codex-turn-status';
import {
  codexTurnRunState,
  codexTurnTerminal,
  isCodexTurnTerminal,
} from '../card/codex-turn-state';
import { renderCard } from '../card/run-renderer';
import type { RunControlIcons } from '../card/run-control-icons';
import { projectNameFromCwd, type Terminal } from '../card/run-state';
import { sendManagedCard } from '../card/managed';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const STATUS_HEARTBEAT_MS = 15_000;
const STATE_VERSION = 1;
const MAX_TURNS_PER_THREAD = 300;

interface SkippedDelivery {
  status: 'skipped';
}

interface CardDelivery {
  status: 'card';
  cardId: string;
  messageId: string;
  sequence: number;
  firstSeenAtMs: number;
  lastActivityAtMs: number;
  lastPushedAtMs: number;
  lastContentHash: string;
  terminal: boolean;
  terminalStatus?: Terminal;
}

type TurnDelivery = SkippedDelivery | CardDelivery;

interface StoredTurn {
  origin: 'bridge' | 'external';
  discoveredAtMs: number;
  deliveries: Record<string, TurnDelivery>;
}

interface StoredThread {
  bindings: string[];
  turns: Record<string, StoredTurn>;
  turnOrder: string[];
  lastObservedUpdatedAtMs?: number;
}

interface StoredState {
  version: 1;
  threads: Record<string, StoredThread>;
}

export interface CodexTurnReaderLike {
  readThread(threadId: string): Promise<CodexThreadSnapshot>;
  listRecentThreads?(limit?: number): Promise<CodexThreadRevision[]>;
  persistedTurnTerminal?(
    snapshot: CodexThreadSnapshot,
    turnId: string,
  ): Promise<'completed' | 'interrupted' | undefined>;
  stop(): Promise<void> | void;
}

export interface CodexTurnSyncDeps {
  channel: LarkChannel;
  controls: Controls;
  sessionCatalog: SessionCatalog;
  profileStateDir: string;
  intervalMs?: number;
  reader?: CodexTurnReaderLike;
  statePath?: string;
  now?: () => number;
}

export interface CodexTurnSyncHandle {
  runNow(): Promise<void>;
  refreshMessage(scope: string, messageId: string): Promise<boolean>;
  stop(): Promise<void>;
}

/**
 * Mirror turns that originate outside the bridge (notably Codex Desktop) into
 * their bound Feishu chats. Bridge-originated turns keep using the existing
 * low-latency event stream and are positively identified by their persisted
 * client user-message id, preventing duplicate replies while both paths
 * coexist. The old prompt marker remains a migration fallback.
 */
export async function startCodexTurnSync(deps: CodexTurnSyncDeps): Promise<CodexTurnSyncHandle> {
  const codex = deps.controls.profileConfig.codex;
  if (deps.controls.profileConfig.agentKind !== 'codex' || !codex?.binaryPath) {
    return { runNow: async () => {}, refreshMessage: async () => false, stop: async () => {} };
  }

  const reader = deps.reader ?? new CodexThreadReader(readerOptions(deps, codex));
  const store = new CodexTurnSyncStore(
    deps.statePath ?? join(deps.profileStateDir, 'codex-turn-sync.json'),
  );
  await store.load();
  const now = deps.now ?? Date.now;
  let stopped = false;
  let running: Promise<void> | undefined;
  let needsInitialRevalidation = true;

  const runNow = async (): Promise<void> => {
    if (stopped) return;
    if (running) return running.catch((err) => log.fail('codex-turn-sync', err, { step: 'poll' }));
    running = syncOnce(deps, reader, store, now, needsInitialRevalidation)
      .then(() => {
        needsInitialRevalidation = false;
      })
      .catch((err) => log.fail('codex-turn-sync', err, { step: 'poll' }))
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  void runNow();
  const timer = setInterval(() => void runNow(), deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  timer.unref?.();

  return {
    runNow,
    async refreshMessage(scope, messageId) {
      // Use the same lock as polling: concurrent refreshes and periodic pushes
      // must never race to allocate a CardKit sequence or overwrite newer output.
      while (running) await running.catch(() => {});
      if (stopped) return false;
      let refreshed = false;
      running = (async () => {
        for (const [threadId, thread] of Object.entries(store.state.threads)) {
          for (const [turnId, stored] of Object.entries(thread.turns)) {
            const delivery = stored.deliveries[scope];
            if (delivery?.status !== 'card' || delivery.messageId !== messageId) continue;
            const binding = activeCodexBindings(deps.sessionCatalog.entries()).get(threadId)
              ?.find((entry) => entry.scopeId === scope);
            if (!binding) throw new Error('Card conversation is no longer bound to this group');
            const snapshot = await reconcileProjectedInterruptions(reader, await reader.readThread(threadId), now());
            const turn = snapshot.turns.find((item) => item.id === turnId);
            if (!turn) throw new Error('Original card turn is unavailable');
            await syncTurnToScope(deps.channel, store, threadId, turn, stored, scope, now(),
              binding.cwdRealpath, deps.controls.runControlIcons, true);
            refreshed = true;
            return;
          }
        }
      })().finally(() => { running = undefined; });
      await running;
      return refreshed;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
      await store.flush();
      await reader.stop();
    },
  };
}

async function syncOnce(
  deps: CodexTurnSyncDeps,
  reader: CodexTurnReaderLike,
  store: CodexTurnSyncStore,
  now: () => number,
  forceRead: boolean,
): Promise<void> {
  const bindings = activeCodexBindings(deps.sessionCatalog.entries());
  let revisions: Map<string, number> | undefined;
  if (reader.listRecentThreads) {
    try {
      revisions = new Map(
        (await reader.listRecentThreads(Math.max(100, bindings.size))).map((thread) => [
          thread.id,
          thread.updatedAtMs,
        ]),
      );
    } catch (err) {
      log.warn('codex-turn-sync', 'thread-list-failed', { err: errorText(err) });
    }
  }
  for (const [threadId, entries] of bindings) {
    const stored = store.state.threads[threadId];
    const revision = revisions?.get(threadId);
    const hasRunningMirroredTurn = stored
      ? Object.values(stored.turns).some((turn) =>
          Object.values(turn.deliveries).some(
            (delivery) => delivery.status === 'card' && !delivery.terminal,
          ))
      : false;
    if (
      !forceRead &&
      stored &&
      !hasRunningMirroredTurn &&
      revisions &&
      (revision === undefined || revision <= (stored.lastObservedUpdatedAtMs ?? 0))
    ) {
      continue;
    }
    let snapshot: CodexThreadSnapshot;
    try {
      snapshot = await reader.readThread(threadId);
      snapshot = await reconcileProjectedInterruptions(reader, snapshot, now());
    } catch (err) {
      log.warn('codex-turn-sync', 'thread-read-failed', {
        threadId,
        err: errorText(err),
      });
      continue;
    }
    await syncThreadSnapshot(deps.channel, store, snapshot, entries, now(), deps.controls.runControlIcons);
    let consumedCreationReplay = false;
    for (const entry of entries) {
      if (!entry.recentTurnReplayCount) continue;
      consumedCreationReplay =
        deps.sessionCatalog.clearRecentTurnReplay(entry.scopeId, threadId) > 0 ||
        consumedCreationReplay;
    }
    if (consumedCreationReplay) await deps.sessionCatalog.flush();
    const synced = store.state.threads[threadId];
    if (synced && revision !== undefined && synced.lastObservedUpdatedAtMs !== revision) {
      synced.lastObservedUpdatedAtMs = revision;
      store.dirty = true;
    }
  }
  await store.flush();
}

async function reconcileProjectedInterruptions(
  reader: CodexTurnReaderLike,
  snapshot: CodexThreadSnapshot,
  nowMs: number,
): Promise<CodexThreadSnapshot> {
  const latest = snapshot.turns.at(-1);
  if (!latest || !isInterruptedTurnStatus(latest.status)) return snapshot;
  if (!reader.persistedTurnTerminal) {
    return isProvisionalInterruptedTurn(snapshot, latest, nowMs)
      ? replaceTurnStatus(snapshot, latest.id, 'inProgress')
      : snapshot;
  }
  const terminal = await reader.persistedTurnTerminal(snapshot, latest.id);
  if (terminal) {
    // The durable event may have landed immediately after the first
    // thread/read. Refresh once through app-server so the terminal card also
    // contains the final message/tool items written just before that event.
    const refreshed = await reader.readThread(snapshot.id);
    const refreshedTurn = refreshed.turns.find((turn) => turn.id === latest.id);
    const current = refreshedTurn ? refreshed : snapshot;
    if (terminal === 'completed' && isInterruptedTurnStatus(refreshedTurn?.status ?? latest.status)) {
      return replaceTurnStatus(current, latest.id, 'completed');
    }
    return current;
  }
  return replaceTurnStatus(snapshot, latest.id, 'inProgress');
}

function replaceTurnStatus(
  snapshot: CodexThreadSnapshot,
  turnId: string,
  status: string,
): CodexThreadSnapshot {
  return {
    ...snapshot,
    turns: snapshot.turns.map((turn) => turn.id === turnId ? { ...turn, status } : turn),
  };
}

async function syncThreadSnapshot(
  channel: LarkChannel,
  store: CodexTurnSyncStore,
  snapshot: CodexThreadSnapshot,
  bindings: SessionCatalogEntry[],
  nowMs: number,
  icons?: RunControlIcons,
): Promise<void> {
  const existing = store.state.threads[snapshot.id];
  const firstSnapshot = !existing;
  const thread = existing ?? { bindings: [], turns: {}, turnOrder: [] };
  store.state.threads[snapshot.id] = thread;
  const scopes = [...new Set(bindings.map((entry) => entry.scopeId).filter(isFeishuScope))];
  const newScopes = scopes.filter((scope) => !thread.bindings.includes(scope));
  const replayTurnsByScope = recentReplayTurnsByScope(snapshot, bindings, newScopes);
  thread.bindings = [...new Set([...thread.bindings, ...scopes])];

  for (const turn of snapshot.turns) {
    let stored = thread.turns[turn.id];
    const isNewTurn = !stored;
    if (!stored) {
      stored = {
        origin: isBridgeTurn(snapshot.id, turn) ? 'bridge' : 'external',
        discoveredAtMs: nowMs,
        deliveries: {},
      };
      thread.turns[turn.id] = stored;
      thread.turnOrder.push(turn.id);
      store.dirty = true;
    }

    const replayScopesForTurn = new Set(
      scopes.filter((scope) => replayTurnsByScope.get(scope)?.has(turn.id)),
    );
    const mirroredBridgeScopes = new Set(
      scopes.filter((scope) =>
        replayScopesForTurn.has(scope) || stored.deliveries[scope]?.status === 'card'),
    );
    if (stored.origin === 'bridge' && mirroredBridgeScopes.size === 0) continue;

    // A newly attached group starts at the current end of a completed
    // transcript. This avoids replaying months of Desktop history into a new
    // chat. A currently-running external turn is useful live state, so it is
    // mirrored even on the first observation.
    if (isCodexTurnTerminal(turn.status)) {
      const baselineScopes = firstSnapshot && isNewTurn ? scopes : newScopes;
      for (const scope of baselineScopes) {
        if (replayTurnsByScope.get(scope)?.has(turn.id)) continue;
        if (!stored.deliveries[scope]) {
          stored.deliveries[scope] = { status: 'skipped' };
          store.dirty = true;
        }
      }
    }

    for (const scope of scopes) {
      if (stored.origin === 'bridge' && !mirroredBridgeScopes.has(scope)) continue;
      const delivery = stored.deliveries[scope];
      if (delivery?.status === 'skipped') continue;
      try {
        await syncTurnToScope(channel, store, snapshot.id, turn, stored, scope, nowMs,
          bindings.find((entry) => entry.scopeId === scope)?.cwdRealpath, icons);
      } catch (err) {
        log.warn('codex-turn-sync', 'delivery-failed', {
          threadId: snapshot.id,
          turnId: turn.id,
          scope,
          err: errorText(err),
        });
      }
    }
  }

  // Creation-time history replay is intentionally attempted once. Failed
  // deliveries are closed as skipped so later polls/restarts cannot replay
  // historical turns outside the group-creation event.
  for (const [scope, turnIds] of replayTurnsByScope) {
    for (const turnId of turnIds) {
      const stored = thread.turns[turnId];
      if (stored && !stored.deliveries[scope]) {
        stored.deliveries[scope] = { status: 'skipped' };
        store.dirty = true;
      }
    }
  }

  trimStoredTurns(thread);
}

function recentReplayTurnsByScope(
  snapshot: CodexThreadSnapshot,
  bindings: SessionCatalogEntry[],
  newScopes: string[],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const latestTurnId = snapshot.turns.at(-1)?.id;
  for (const scope of newScopes) {
    const count = Math.max(
      0,
      ...bindings
        .filter((entry) => entry.scopeId === scope)
        .map((entry) => entry.recentTurnReplayCount ?? 0),
    );
    if (count === 0) continue;
    const ids = snapshot.turns
      // Creation replay includes the current tail as well. A bridge-owned tail
      // can be projected as interrupted and reconciled to running before this
      // selection; omitting it would leave its live card undiscoverable.
      .filter((turn) => isCodexTurnTerminal(turn.status) || turn.id === latestTurnId)
      .slice(-count)
      .map((turn) => turn.id);
    result.set(scope, new Set(ids));
  }
  return result;
}

async function syncTurnToScope(
  channel: LarkChannel,
  store: CodexTurnSyncStore,
  threadId: string,
  turn: CodexThreadTurn,
  stored: StoredTurn,
  scope: string,
  nowMs: number,
  projectCwd?: string,
  icons?: RunControlIcons,
  forceUpdate = false,
): Promise<void> {
  const target = targetFromScope(scope);
  if (!target) return;
  const contentHash = turnContentHash(turn);
  let delivery = stored.deliveries[scope];

  if (!delivery) {
    const input = externalUserText(turn);
    if (input) {
      await channel.send(target.chatId, {
        markdown: `💻 **来自 Codex 桌面 App**\n\n${truncate(input, 8_000)}`,
      });
    }
    const state = codexTurnRunState(turn, {
      firstSeenAtMs: nowMs,
      lastActivityAtMs: nowMs,
      checkedAtMs: nowMs,
    });
    const sent = await sendManagedCard(
      channel,
      target.chatId,
      renderCard({ ...state, ...(projectCwd ? { projectName: projectNameFromCwd(projectCwd) } : {}) }, icons),
    );
    delivery = {
      status: 'card',
      cardId: sent.cardId,
      messageId: sent.messageId,
      sequence: 0,
      firstSeenAtMs: nowMs,
      lastActivityAtMs: nowMs,
      lastPushedAtMs: nowMs,
      lastContentHash: contentHash,
      terminal: isCodexTurnTerminal(turn.status),
      terminalStatus: state.terminal,
    };
    stored.deliveries[scope] = delivery;
    store.dirty = true;
    await store.flush();
    log.info('codex-turn-sync', 'external-turn-created', {
      threadId,
      turnId: turn.id,
      scope,
      messageId: sent.messageId,
    });
    return;
  }
  if (delivery.status !== 'card') return;

  const wasTerminal = delivery.terminal;
  const nextTerminalStatus = codexTurnTerminal(turn.status);
  const terminal = nextTerminalStatus !== 'running';
  const changed = contentHash !== delivery.lastContentHash;
  // A turn can be observed as interrupted while Codex Desktop is still
  // transitioning it, then return to inProgress (or finish normally). Do not
  // make the first terminal snapshot sticky: update the existing card whenever
  // a later snapshot differs. Unchanged terminal cards still remain idle.
  const terminalKindChanged = delivery.terminalStatus !== undefined &&
    delivery.terminalStatus !== nextTerminalStatus;
  if (!forceUpdate && delivery.terminal && terminal && !terminalKindChanged) return;
  if (!forceUpdate && !changed && !terminal && nowMs - delivery.lastPushedAtMs < STATUS_HEARTBEAT_MS) return;

  if (changed) delivery.lastActivityAtMs = nowMs;
  delivery.sequence += 1;
  delivery.lastPushedAtMs = nowMs;
  delivery.lastContentHash = contentHash;
  delivery.terminalStatus = nextTerminalStatus;
  store.dirty = true;
  // Persist the next CardKit sequence before the API call. If the process dies
  // after Feishu accepts the update, a restart will never reuse that sequence.
  await store.flush();
  const state = codexTurnRunState(turn, {
    firstSeenAtMs: delivery.firstSeenAtMs,
    lastActivityAtMs: delivery.lastActivityAtMs,
    checkedAtMs: nowMs,
  });
  await channel.updateCardById(
    delivery.cardId,
    renderCard({ ...state, ...(projectCwd ? { projectName: projectNameFromCwd(projectCwd) } : {}) }, icons),
    delivery.sequence,
  );
  delivery.terminal = terminal;
  store.dirty = true;
  await store.flush();
  log.info('codex-turn-sync', 'external-turn-updated', {
    threadId,
    turnId: turn.id,
    scope,
    terminal,
    reopened: wasTerminal && !terminal,
    sequence: delivery.sequence,
  });
}

function externalUserText(turn: CodexThreadTurn): string {
  const user = turn.items.find((item) => item.type === 'userMessage');
  return user ? textFromUnknown(user.content).trim() : '';
}

function isBridgeTurn(threadId: string, turn: CodexThreadTurn): boolean {
  const user = turn.items.find((item) => item.type === 'userMessage');
  if (isCodexBridgeClientMessageId(user?.clientId)) return true;
  // Legacy bridge turns created before clientUserMessageId was wired used a
  // prompt wrapper. Keep recognizing those so an upgrade does not mirror old
  // Feishu messages back into the same group.
  const text = externalUserText(turn).trimStart();
  return text.startsWith('# lark-channel-bridge message') ||
    text.includes('<bridge_context>') ||
    isClaimedCodexBridgeTurn(threadId, turn.id, externalUserText(turn));
}

function textFromUnknown(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input
    .map((value) => {
      if (typeof value === 'string') return value;
      if (!value || typeof value !== 'object') return '';
      const record = value as Record<string, unknown>;
      return stringValue(record.text) ?? stringValue(record.content) ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

function turnContentHash(turn: CodexThreadTurn): string {
  return createHash('sha256').update(JSON.stringify(turn)).digest('hex');
}

function activeCodexBindings(entries: SessionCatalogEntry[]): Map<string, SessionCatalogEntry[]> {
  const out = new Map<string, SessionCatalogEntry[]>();
  for (const entry of entries) {
    if (entry.status !== 'active' || entry.agentId !== 'codex' || !entry.threadId || !isFeishuScope(entry.scopeId)) continue;
    const current = out.get(entry.threadId) ?? [];
    current.push(entry);
    out.set(entry.threadId, current);
  }
  return out;
}

function isFeishuScope(scope: string): boolean {
  return /^oc_[A-Za-z0-9]+(?::.+)?$/.test(scope);
}

function targetFromScope(scope: string): { chatId: string } | undefined {
  const match = /^(oc_[A-Za-z0-9]+)/.exec(scope);
  return match?.[1] ? { chatId: match[1] } : undefined;
}

function trimStoredTurns(thread: StoredThread): void {
  while (thread.turnOrder.length > MAX_TURNS_PER_THREAD) {
    const oldest = thread.turnOrder.shift();
    if (oldest) delete thread.turns[oldest];
  }
}

function readerOptions(
  deps: CodexTurnSyncDeps,
  codex: NonNullable<Controls['profileConfig']['codex']>,
): CodexThreadReaderOptions {
  return {
    binary: codex.binaryPath!,
    profileStateDir: deps.profileStateDir,
    ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
    ...(codex.inheritCodexHome !== undefined ? { inheritCodexHome: codex.inheritCodexHome } : {}),
  };
}

class CodexTurnSyncStore {
  state: StoredState = { version: STATE_VERSION, threads: {} };
  dirty = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoredState>;
      if (raw.version === STATE_VERSION && raw.threads && typeof raw.threads === 'object') {
        this.state = raw as StoredState;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('codex-turn-sync', 'state-load-failed', { err: errorText(err) });
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return this.saving;
    this.dirty = false;
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    this.saving = this.saving.then(() => writeFileAtomic(this.path, payload, { mode: 0o600 }));
    return this.saving;
  }
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
