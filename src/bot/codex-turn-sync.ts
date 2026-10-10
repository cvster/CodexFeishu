import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { CodexSubmissionRecord, CodexSubmissionStore } from '../session/codex-submissions';
import { resolveSharedCodexEndpoint } from '../../packages/codex-core/src/queue';
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
import { reconcileCodexThreadSnapshot as reconcileProjectedInterruptions } from '../session/codex-turn-status';
import {
  codexTurnRunState,
  codexTurnTerminal,
  isCodexTurnTerminal,
} from '../card/codex-turn-state';
import { renderCard } from '../card/run-renderer';
import type { RunControlIcons } from '../card/run-control-icons';
import { projectNameFromCwd, type Terminal } from '../card/run-state';
import { sendManagedCard } from '../card/managed';
import { getMessageReplyMode, getShowToolCalls } from '../config/schema';
import { renderText } from '../card/text-renderer';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const STATUS_HEARTBEAT_MS = 15_000;
const TERMINAL_TAIL_SETTLE_MS = 60_000;
const STATE_VERSION = 2;
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
  terminalObservedAtMs?: number;
}

interface TextDelivery { status: 'text'; messageId: string }
type TurnDelivery = SkippedDelivery | CardDelivery | TextDelivery;

interface StoredTurn {
  origin: 'bridge' | 'external';
  discoveredAtMs: number;
  lastStatus?: string;
  userEchoed?: Record<string, boolean>;
  replyTargets?: Record<string, { replyTo: string; replyInThread?: boolean }>;
  deliveries: Record<string, TurnDelivery>;
}

interface StoredThread {
  bindings: string[];
  turns: Record<string, StoredTurn>;
  turnOrder: string[];
  lastObservedUpdatedAtMs?: number;
}

interface StoredState {
  version: 2;
  threads: Record<string, StoredThread>;
}

export interface CodexTurnReaderLike {
  listArchivedThreadIds?(): Promise<string[]>;
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
  nameSync?: { observe(snapshot: CodexThreadSnapshot, entries: SessionCatalogEntry[], isActive?: (scope: string) => boolean): Promise<void> };
  submissionStore?: CodexSubmissionStore;
}

export interface CodexTurnSyncHandle {
  isThreadArchived(threadId: string): Promise<boolean>;
  isScopeArchived(scope: string): Promise<boolean>;
  runNow(): Promise<void>;
  registerSubmission(record: CodexSubmissionRecord): Promise<void>;
  observeTurn(scope: string, threadId: string, turnId: string, replyTo: string, replyInThread?: boolean): void;
  refreshMessage(scope: string, messageId: string): Promise<boolean>;
  stop(): Promise<void>;
}

/**
 * The sole Codex reply writer, regardless of where input originated. Delivery
 * identity is (thread id, turn id, bound scope); source only controls input echo.
 * Native submitters supply exact turn IDs so even a fast first turn is delivered
 * rather than mistaken for pre-existing history on a newly bound thread.
 */
export async function startCodexTurnSync(deps: CodexTurnSyncDeps): Promise<CodexTurnSyncHandle> {
  const codex = deps.controls.profileConfig.codex;
  if (deps.controls.profileConfig.agentKind !== 'codex' || !codex?.binaryPath) {
    return { isThreadArchived: async (threadId) => deps.sessionCatalog.isThreadArchived(threadId),
      isScopeArchived: async (scope) => deps.sessionCatalog.isScopeArchived(scope), runNow: async () => {}, registerSubmission: async () => {}, observeTurn: () => {}, refreshMessage: async () => false, stop: async () => {} };
  }

  let kick = (): void => {};
  const reader = deps.reader ?? await createSyncReader(deps, codex, () => kick());
  const store = new CodexTurnSyncStore(
    deps.statePath ?? join(deps.profileStateDir, 'codex-turn-sync.json'),
  );
  await store.load();
  const now = deps.now ?? Date.now;
  let stopped = false;
  let running: Promise<void> | undefined;
  const submitted = new Map<string, SubmittedTurn>();
  const preparing = new Map<string, CodexSubmissionRecord>();

  const runNow = async (): Promise<void> => {
    if (stopped) return;
    if (running) return running.catch((err) => log.fail('codex-turn-sync', err, { step: 'poll' }));
    running = syncOnce(deps, reader, store, now, submitted,
      () => [...preparing.values(), ...(deps.submissionStore?.records() ?? [])])
      .catch((err) => log.fail('codex-turn-sync', err, { step: 'poll' }))
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  kick = () => { void runNow(); };

  void runNow();
  const timer = setInterval(() => void runNow(), deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  timer.unref?.();

  return {
    async isThreadArchived(threadId) {
      if (deps.sessionCatalog.isThreadArchived(threadId)) return true;
      if (!reader.listArchivedThreadIds) throw new Error('Archive lookup unavailable');
      const archived = await reconcileArchives(deps, reader, true);
      if (!archived.has(threadId)) return false;
      deps.sessionCatalog.archiveCodexThread(threadId);
      await deps.sessionCatalog.flush();
      return true;
    },
    async isScopeArchived(scope) {
      if (deps.sessionCatalog.isScopeArchived(scope)) return true;
      if (!deps.sessionCatalog.entries().some((e) => e.agentId === 'codex' && e.scopeId === scope)) return false;
      if (!reader.listArchivedThreadIds) throw new Error('Archive lookup unavailable');
      await reconcileArchives(deps, reader);
      return deps.sessionCatalog.isScopeArchived(scope);
    },
    runNow,
    async registerSubmission(record) {
      if (stopped) throw new Error('Reply synchronizer stopped');
      preparing.set(record.id, structuredClone(record));
      // The outbox is the durable source; no response polling holds submission.
      if (deps.submissionStore) preparing.delete(record.id);
    },
    observeTurn(scope, threadId, turnId, replyTo, replyInThread) {
      if (stopped) return;
      submitted.set(submissionKey(threadId, turnId, scope),
        { scope, threadId, turnId, replyTo, replyInThread });
      void runNow();
    },
    async refreshMessage(scope, messageId) {
      if (deps.sessionCatalog.isScopeArchived(scope)) throw new Error('会话已归档。');
      await reconcileArchives(deps, reader);
      if (deps.sessionCatalog.isScopeArchived(scope)) throw new Error('会话已归档。');
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
            if (currentEntries(deps, threadId, [binding]).length === 0) throw new Error('会话已归档或已重新绑定。');
            const turn = snapshot.turns.find((item) => item.id === turnId);
            if (!turn) throw new Error('Original card turn is unavailable');
            await syncTurnToScope(deps.channel, store, threadId, turn, stored, scope, now(),
              binding.cwdRealpath, deps.controls.runControlIcons, true, deps.controls,
              false, () => currentEntries(deps, threadId, [binding]).length > 0);
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

interface SubmittedTurn {
  scope: string; threadId: string; turnId: string; replyTo: string; replyInThread?: boolean;
}
function submissionKey(threadId: string, turnId: string, scope: string): string {
  return JSON.stringify([threadId, turnId, scope]);
}

async function syncOnce(
  deps: CodexTurnSyncDeps,
  reader: CodexTurnReaderLike,
  store: CodexTurnSyncStore,
  now: () => number,
  submitted: Map<string, SubmittedTurn>,
  records: () => CodexSubmissionRecord[],
): Promise<void> {
  await reconcileArchives(deps, reader);
  const bindings = activeCodexBindings(deps.sessionCatalog.entries());
  for (const [threadId, entries] of bindings) {
    // thread/list timestamps have coarse resolution and may advance before
    // items are persisted. They are not a safe message cursor: a fast Desktop
    // turn can start and finish without changing the observed watermark.
    // Read every bound thread; persistent turn/item identity deduplicates it.
    let snapshot: CodexThreadSnapshot;
    try {
      snapshot = await reader.readThread(threadId);
      snapshot = await reconcileProjectedInterruptions(reader, snapshot, now());
      deps.controls.codexUserInput?.observeSnapshot?.(snapshot);
      const latest = snapshot.turns.at(-1);
      if (latest && isCodexTurnTerminal(latest.status)) deps.controls.codexUserInput?.endTurn(threadId, latest.id);
    } catch (err) {
      log.warn('codex-turn-sync', 'thread-read-failed', {
        threadId,
        err: errorText(err),
      });
      continue;
    }
    const liveEntries = currentEntries(deps, threadId, entries);
    if (liveEntries.length === 0) continue;
    const matched = associateSubmissions(snapshot, records());
    for (const { record, turn } of matched) {
      if (!record.replyTo || !liveEntries.some(e => e.scopeId === record.scope)) continue;
      submitted.set(submissionKey(threadId, turn.id, record.scope), {
        scope: record.scope, threadId, turnId: turn.id, replyTo: record.replyTo, replyInThread: record.replyInThread,
      });
    }
    await syncThreadSnapshot(deps.channel, store, snapshot, liveEntries, now(),
      deps.controls.runControlIcons, submitted, deps.controls,
      (scope) => currentEntries(deps, threadId, liveEntries).some((entry) => entry.scopeId === scope));
    for (const { record, turn } of matched) {
      if (!deps.submissionStore || record.status === 'completed') continue;
      if (record.turnId !== turn.id || isCodexTurnTerminal(turn.status)) {
        await deps.submissionStore.mark(record.id, { turnId: turn.id,
          ...(isCodexTurnTerminal(turn.status) ? { status: 'completed', completedAtMs: now() } : {}) });
      }
    }
    // Name failures must not prevent reply delivery or other thread polling.
    try {
      const nameEntries = currentEntries(deps, threadId, liveEntries);
      if (nameEntries.length > 0) await deps.nameSync?.observe(snapshot, nameEntries,
        (scope) => currentEntries(deps, threadId, nameEntries).some((entry) => entry.scopeId === scope));
    } catch (err) {
      log.warn('codex-turn-sync', 'name-sync-failed', { threadId, err: errorText(err) });
    }
    let consumedCreationReplay = false;
    for (const entry of entries) {
      if (!entry.recentTurnReplayCount) continue;
      consumedCreationReplay =
        deps.sessionCatalog.clearRecentTurnReplay(entry.scopeId, threadId) > 0 ||
        consumedCreationReplay;
    }
    if (consumedCreationReplay) await deps.sessionCatalog.flush();
  }
  await store.flush();
}

function currentEntries(deps: CodexTurnSyncDeps, threadId: string, previous: SessionCatalogEntry[]): SessionCatalogEntry[] {
  const keys = new Set((activeCodexBindings(deps.sessionCatalog.entries()).get(threadId) ?? []).map((e) => e.key));
  return previous.filter((entry) => keys.has(entry.key));
}

async function reconcileArchives(deps: CodexTurnSyncDeps, reader: CodexTurnReaderLike, force = false): Promise<Set<string>> {
  // Optional only for test/legacy injected readers; production implements it.
  if (!reader.listArchivedThreadIds || (!force && deps.sessionCatalog.entries().length === 0)) return new Set();
  const archived = new Set(await reader.listArchivedThreadIds());
  let changed = false;
  for (const entry of deps.sessionCatalog.entries()) {
    if (entry.agentId !== 'codex' || !entry.threadId || !archived.has(entry.threadId) ||
        deps.sessionCatalog.isThreadArchived(entry.threadId)) continue;
    deps.sessionCatalog.archiveCodexThread(entry.threadId);
    changed = true;
  }
  if (changed) await deps.sessionCatalog.flush();
  return archived;
}


async function syncThreadSnapshot(
  channel: LarkChannel,
  store: CodexTurnSyncStore,
  snapshot: CodexThreadSnapshot,
  bindings: SessionCatalogEntry[],
  nowMs: number,
  icons?: RunControlIcons,
  submitted = new Map<string, SubmittedTurn>(),
  controls?: Controls,
  isScopeActive: (scope: string) => boolean = () => true,
): Promise<void> {
  const existing = store.state.threads[snapshot.id];
  const firstSnapshot = !existing;
  const thread = existing ?? { bindings: [], turns: {}, turnOrder: [] };
  store.state.threads[snapshot.id] = thread;
  const scopes = [...new Set(bindings.map((entry) => entry.scopeId).filter(isFeishuScope))];
  const newScopes = scopes.filter((scope) => !thread.bindings.includes(scope));
  const replayTurnsByScope = recentReplayTurnsByScope(snapshot, bindings, newScopes);
  thread.bindings = [...new Set([...thread.bindings, ...scopes])];

  // Never rediscover pruned history as new output on the next poll.
  for (const turn of snapshot.turns.slice(-MAX_TURNS_PER_THREAD)) {
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
    // The initial snapshot may have no userMessage yet. Re-evaluate source as
    // items hydrate, but never let that reclassification create another card.
    if (stored.origin !== 'bridge' && isBridgeTurn(snapshot.id, turn)) {
      stored.origin = 'bridge';
      store.dirty = true;
    }
    if (stored.lastStatus !== turn.status) {
      stored.lastStatus = turn.status;
      store.dirty = true;
    }
    for (const scope of scopes) {
      const request = submitted.get(submissionKey(snapshot.id, turn.id, scope));
      if (!request) continue;
      store.dirty = true;
      stored.origin = 'bridge';
      (stored.replyTargets ??= {})[scope] = {
        replyTo: request.replyTo, replyInThread: request.replyInThread,
      };
      if (stored.deliveries[scope]?.status === 'skipped') delete stored.deliveries[scope];
    }

    // A newly attached group starts at the current end of a completed
    // transcript. This avoids replaying months of Desktop history into a new
    // chat. A currently-running external turn is useful live state, so it is
    // mirrored even on the first observation.
    if (isCodexTurnTerminal(turn.status)) {
      const baselineScopes = firstSnapshot && isNewTurn ? scopes : newScopes;
      for (const scope of baselineScopes) {
        if (replayTurnsByScope.get(scope)?.has(turn.id)) continue;
        if (submitted.has(submissionKey(snapshot.id, turn.id, scope))) continue;
        if (!stored.deliveries[scope]) {
          stored.deliveries[scope] = { status: 'skipped' };
          store.dirty = true;
        }
      }
    }

    for (const scope of scopes) {
      const delivery = stored.deliveries[scope];
      if (!isScopeActive(scope)) continue;
      if (delivery?.status === 'skipped') continue;
      try {
        await syncTurnToScope(channel, store, snapshot.id, turn, stored, scope, nowMs,
          bindings.find((entry) => entry.scopeId === scope)?.cwdRealpath, icons, false, controls,
          replayScopesForTurn.has(scope), () => isScopeActive(scope));
        if (stored.deliveries[scope]) submitted.delete(submissionKey(snapshot.id, turn.id, scope));
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
  controls?: Controls,
  creationReplay = false,
  isActive: () => boolean = () => true,
): Promise<void> {
  if (!isActive()) return;
  const target = targetFromScope(scope);
  if (!target) return;
  const waitingForInput = controls?.codexUserInput?.isWaiting(threadId, turn.id) ?? false;
  const contentHash = turnContentHash(turn) + (waitingForInput ? ':waiting' : '');
  let delivery = stored.deliveries[scope];
  const replyMode = controls ? getMessageReplyMode(controls.cfg) : 'card';
  if (!delivery && replyMode === 'text' && !isCodexTurnTerminal(turn.status)) return;
  // Input echo is independent from answer delivery and can be filled in after
  // turn/started's empty item list. Feishu-origin inputs are already in chat.
  const input = externalUserText(turn);
  if ((stored.origin === 'external' || creationReplay) && input && !stored.userEchoed?.[scope]) {
    await channel.send(target.chatId, {
      markdown: `${stored.origin === 'bridge' ? '💬 **历史消息**' : '💻 **来自 Codex 桌面 App**'}\n\n${truncate(input, 8_000)}`,
    });
    (stored.userEchoed ??= {})[scope] = true;
    store.dirty = true;
    await store.flush();
  }
  const renderState = (runtime: { firstSeenAtMs: number; lastActivityAtMs: number; checkedAtMs: number }) => {
    const state = codexTurnRunState(turn, runtime);
    if (state.terminal === 'running' && waitingForInput) state.footer = 'waiting_input';
    if (projectCwd) state.projectName = projectNameFromCwd(projectCwd);
    if (controls && !getShowToolCalls(controls.cfg)) state.blocks = state.blocks.filter((block) => block.kind !== 'tool');
    return state;
  };

  if (!delivery) {
    if (!isActive()) return;
    const state = renderState({
      firstSeenAtMs: nowMs,
      lastActivityAtMs: nowMs,
      checkedAtMs: nowMs,
    });
    if (replyMode === 'text') {
      const sent = await channel.send(target.chatId, { markdown: renderText(state) }, stored.replyTargets?.[scope]);
      stored.deliveries[scope] = { status: 'text', messageId: sent.messageId };
      store.dirty = true;
      await store.flush();
      return;
    }
    const sent = await sendManagedCard(
      channel,
      target.chatId,
      renderCard(state, icons),
      { ...stored.replyTargets?.[scope], isActive },
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
      ...(isCodexTurnTerminal(turn.status) ? { terminalObservedAtMs: nowMs } : {}),
    };
    stored.deliveries[scope] = delivery;
    store.dirty = true;
    await store.flush();
    log.info('codex-turn-sync', 'turn-card-created', {
      threadId,
      turnId: turn.id,
      scope,
      messageId: sent.messageId,
      origin: stored.origin,
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
  const settlingFinalItems = delivery.terminalObservedAtMs !== undefined &&
    nowMs - delivery.terminalObservedAtMs <= TERMINAL_TAIL_SETTLE_MS;
  // Catch a newly completed turn's final persisted items without rewriting
  // long-closed historical cards merely because CLI projection metadata changed.
  if (!forceUpdate && delivery.terminal && terminal && !terminalKindChanged &&
    (!changed || !settlingFinalItems)) return;
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
  if (!isActive()) return;
  const state = renderState({
    firstSeenAtMs: delivery.firstSeenAtMs,
    lastActivityAtMs: delivery.lastActivityAtMs,
    checkedAtMs: nowMs,
  });
  await channel.updateCardById(
    delivery.cardId,
    renderCard(state, icons),
    delivery.sequence,
  );
  delivery.terminal = terminal;
  if (terminal && !wasTerminal) delivery.terminalObservedAtMs = nowMs;
  if (!terminal) delete delivery.terminalObservedAtMs;
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

function associateSubmissions(snapshot: CodexThreadSnapshot, all: CodexSubmissionRecord[]):
  Array<{ record: CodexSubmissionRecord; turn: CodexThreadTurn }> {
  const records = [...new Map(all.map(r => [r.id, r])).values()].filter(r => r.threadId === snapshot.id &&
    r.prompt !== undefined && r.status !== 'rejected' && r.status !== 'cancelled');
  const result: Array<{ record: CodexSubmissionRecord; turn: CodexThreadTurn }> = [];
  for (const record of records) {
    const exact = snapshot.turns.find(t => t.id === record.turnId ||
      (record.clientUserMessageId && t.items.some(i => i.type === 'userMessage' && i.clientId === record.clientUserMessageId)));
    if (exact) { result.push({ record, turn: exact }); continue; }
    if (record.transport !== 'cli') continue;
    const candidates = snapshot.turns.filter(t => !record.knownTurnIds?.includes(t.id) &&
      (t.startedAtMs === undefined || t.startedAtMs >= record.createdAtMs - 5_000) &&
      externalUserText(t) === record.prompt?.trim());
    // Text is only a provenance fallback, never the submission completion gate.
    if (candidates.length !== 1 || records.filter(r => r.transport === 'cli' && r.prompt?.trim() === record.prompt?.trim() &&
      !r.turnId).length !== 1) continue;
    result.push({ record, turn: candidates[0]! });
  }
  return result;
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

async function createSyncReader(deps: CodexTurnSyncDeps,
  codex: NonNullable<Controls['profileConfig']['codex']>, onChange: () => void): Promise<CodexTurnReaderLike> {
  const opts = readerOptions(deps, codex);
  const fallback = new CodexThreadReader(opts);
  const remote = await resolveSharedCodexEndpoint({ remote: process.env.CODEX_QUEUE_REMOTE,
    ...(codex.codexHome ? { codexHome: codex.codexHome } : {}) });
  if (!remote) return fallback;
  const shared = new CodexThreadReader({ ...opts, sharedServer: true, passive: true, remote,
    onNotification: method => { if (method === 'turn/completed' || method === 'thread/status/changed' ||
      method === 'thread/queue/changed' || method.startsWith('item/')) onChange(); } });
  try { await shared.connect(); }
  catch { await shared.stop(); return fallback; }
  return {
    async readThread(threadId) {
      try { return await shared.readThread(threadId); }
      catch (error) {
        log.warn('codex-turn-sync', 'shared-reader-fallback', { threadId, err: errorText(error) });
        return fallback.readThread(threadId);
      }
    },
    listArchivedThreadIds: () => fallback.listArchivedThreadIds(),
    persistedTurnTerminal: (snapshot, turnId) => fallback.persistedTurnTerminal(snapshot, turnId),
    async stop() { await Promise.all([shared.stop(), fallback.stop()]); },
  };
}

class CodexTurnSyncStore {
  state: StoredState = { version: STATE_VERSION, threads: {} };
  dirty = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as { version?: number; threads?: StoredState['threads'] };
      if ((raw.version === 1 || raw.version === STATE_VERSION) && raw.threads && typeof raw.threads === 'object') {
        this.state = { version: STATE_VERSION, threads: raw.threads };
        if (raw.version === 1) {
          // Old bridge turns were answered by the former streaming path. Do
          // not replay those answers on upgrade. Existing mirror cards retain
          // ownership and keep receiving updates, including active turns.
          for (const thread of Object.values(raw.threads)) {
            for (const turn of Object.values(thread.turns)) {
              turn.userEchoed = Object.fromEntries(Object.keys(turn.deliveries).map((scope) => [scope, true]));
              if (turn.origin !== 'bridge') continue;
              for (const scope of thread.bindings) turn.deliveries[scope] ??= { status: 'skipped' };
            }
          }
          this.dirty = true;
        }
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
