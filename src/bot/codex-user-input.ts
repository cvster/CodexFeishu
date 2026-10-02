import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import { CodexThreadReader, type CodexThreadSnapshot } from '../session/codex-thread-reader';
import { codexAsyncAnsweredIds, parseCodexAsyncInput, serializeCodexAsyncAnswers, CodexAsyncAnswerUnconfirmedError } from '../session/codex-async-input';
import { codexInputKey, parseCodexInputRequest, type CodexInputPrompt, type CodexInputRequest, type CodexRequestId } from '../session/codex-user-input';
import { codexAnswersFromForm, codexInputCard, type InputCardStatus } from '../card/codex-input';
import { sendManagedCard } from '../card/managed';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';

interface InputDelivery {
  scope: string; token: string; cardId: string; messageId: string; sequence: number;
  lastStatus?: InputCardStatus;
}
interface StoredInput {
  request: CodexInputRequest;
  status: InputCardStatus;
  deliveries: InputDelivery[];
}
type InputTarget = { scope: string; replyTo?: string; replyInThread?: boolean };
interface LiveInput { source: string; prompt: CodexInputPrompt; target?: InputTarget }
export interface CodexInputHandle {
  observeSnapshot(snapshot: CodexThreadSnapshot): void;
  accept(prompt: CodexInputPrompt, source: string, target?: { scope: string; replyTo?: string; replyInThread?: boolean }): void;
  resolve(threadId: string, requestId: CodexRequestId, source: string): void;
  endTurn(threadId: string, turnId: string): void;
  isWaiting(threadId: string, turnId: string): boolean;
  handleAction(scope: string, messageId: string, token: string, form?: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
}
export interface CodexInputDeps {
  channel: LarkChannel; controls: Controls; sessionCatalog: SessionCatalog;
  profileStateDir: string;
  /** Test seam. Real watcher ONLY uses the shared writer daemon. */
  readerFactory?: (options: ConstructorParameters<typeof CodexThreadReader>[0]) =>
    Pick<CodexThreadReader, 'watchLoadedThread' | 'stop'> & Partial<Pick<CodexThreadReader, 'readThreadStatus' | 'readThread' | 'steerTurn'>>;
  intervalMs?: number;
}

/** Interactive prompts are separate UI, never an extra assistant-answer writer. */
export async function startCodexUserInput(deps: CodexInputDeps): Promise<CodexInputHandle> {
  const path = join(deps.profileStateDir, 'codex-user-input.json');
  const stored = new Map<string, StoredInput>();
  const live = new Map<string, LiveInput>();
  const deliveryQueued = new Set<string>();
  let tail = Promise.resolve();
  let stopped = false;
  let watcherRunning = false;
  let retryAt = 0;
  let lastWarning = 0;
  const retryThreadAt = new Map<string, number>();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = tail.then(task);
    tail = next.catch((err) => log.fail('codex-input', err, { step: 'delivery' }));
    return next;
  };
  const persist = async () => {
    // Never persist answers, credentials, or transport callbacks.
    const entries = [...stored.entries()];
    while (entries.length > 300) {
      const index = entries.findIndex(([, record]) => record.status === 'resolved' || record.status === 'submitted');
      if (index < 0) break;
      const [removed] = entries.splice(index, 1);
      if (removed) stored.delete(removed[0]);
    }
    await writeFileAtomic(path, JSON.stringify({ version: 1, entries }, null, 2) + '\n');
  };
  const render = async (record: StoredInput) => {
    for (const delivery of record.deliveries) {
      if (delivery.lastStatus === record.status) continue;
      delivery.sequence++;
      await persist(); // sequence reserved before remote update
      const pushedStatus = record.status;
      try {
        await deps.channel.updateCardById(delivery.cardId,
          codexInputCard(record.request, delivery.token, pushedStatus), delivery.sequence);
        delivery.lastStatus = pushedStatus;
      } catch (err) { log.fail('codex-input', err, { step: 'update' }); }
    }
    void deps.controls.codexReplySync?.runNow();
  };
  const bindings = (threadId: string) => deps.sessionCatalog.entries().filter((entry) =>
    entry.status === 'active' && entry.agentId === 'codex' && entry.threadId === threadId &&
    (!entry.botAppId || entry.botAppId === deps.controls.profileConfig.accounts.app.id) &&
    /^oc_[A-Za-z0-9]+(?::.+)?$/.test(entry.scopeId));
  const end = (key: string, status: InputCardStatus) => {
    live.delete(key);
    const record = stored.get(key);
    if (!record || record.status === 'resolved' || record.status === 'submitted') return;
    record.status = status;
    void enqueue(async () => { await persist(); await render(record); });
  };
  const handle: CodexInputHandle = {
    observeSnapshot(snapshot) {
      if (stopped) return;
      // Old/history questions are never resurrected. Async controls live only
      // in the current in-flight turn, just as they do in Desktop.
      const latest = snapshot.turns.at(-1);
      const active = latest?.status === 'inProgress' ? latest : undefined;
      const answered = active ? codexAsyncAnsweredIds(active) : new Set<string>();
      for (const [key, record] of stored) {
        if (record.request.kind !== 'async' || record.request.threadId !== snapshot.id) continue;
        if (record.request.turnId !== active?.id || !active.items.some((item) => item.id === record.request.itemId) ||
          answered.has(record.request.itemId) || record.request.questions.every((q) => answered.has(q.id))) end(key, 'resolved');
      }
      if (!active) return;
      for (const item of active.items) {
        const request = parseCodexAsyncInput(snapshot.id, active.id, item);
        if (!request) continue;
        const key = codexInputKey(request);
        const previous = stored.get(key)?.request.answeredQuestionIds ?? [];
        request.answeredQuestionIds = request.questions.filter((q) => previous.includes(q.id) ||
          answered.has(q.id) || answered.has(request.itemId)).map((q) => q.id);
        if (request.questions.every((q) => request.answeredQuestionIds!.includes(q.id))) { end(key, 'resolved'); continue; }
        // A fresh bridge turn already has its actual stdio writer callback.
        // Never replace it with a different server's connection.
        const existing = live.get(key);
        if (existing && existing.source !== 'async-snapshot') {
          handle.accept({ ...existing.prompt, request }, existing.source, existing.target);
          continue;
        }
        handle.accept({ requestId: request.itemId, request, async respond(answers) {
          if (!reader?.readThread || !reader.steerTurn) throw new Error('当前连接不支持异步回答，请在 Codex 桌面回答');
          let current: CodexThreadSnapshot;
          try { current = await reader.readThread(request.threadId); }
          catch { throw new Error('无法连接正在运行任务的公开 app-server，请在 Codex 桌面回答；不会排队新开一轮'); }
          const turn = current.turns.at(-1);
          if (turn?.id !== request.turnId || turn.status !== 'inProgress' ||
            !turn.items.some((value) => value.id === request.itemId) ||
            codexAsyncAnsweredIds(turn).has(request.itemId) ||
            Object.keys(answers).some((id) => codexAsyncAnsweredIds(turn).has(id))) return false;
          await reader.steerTurn(request.threadId, request.turnId, serializeCodexAsyncAnswers(request, answers));
          return true;
        } }, 'async-snapshot');
      }
    },
    accept(prompt, source, target) {
      if (stopped) return;
      const allowed = bindings(prompt.request.threadId);
      const targets = target ? allowed.filter((entry) => entry.scopeId === target.scope) : allowed;
      if (!targets.length) return;
      const key = codexInputKey(prompt.request);
      const previous = stored.get(key);
      // Replay may race a response we already sent. Never resurrect it.
      if (previous?.status === 'resolved' || previous?.status === 'submitted' || previous?.status === 'submitting' || previous?.status === 'unconfirmed') return;
      live.set(key, { source, prompt, target });
      const requestChanged = previous?.request.kind === 'async' && JSON.stringify(previous.request) !== JSON.stringify(prompt.request);
      if (requestChanged) for (const delivery of previous.deliveries) delivery.lastStatus = undefined;
      if (previous?.status === 'waiting' && targets.every((entry) => previous.deliveries.some((delivery) =>
        delivery.scope === entry.scopeId && delivery.lastStatus === 'waiting'))) return;
      const record = previous ?? { request: prompt.request, status: 'waiting', deliveries: [] };
      record.request = prompt.request;
      record.status = 'waiting';
      stored.set(key, record);
      if (deliveryQueued.has(key)) return;
      deliveryQueued.add(key);
      void enqueue(async () => {
        try {
          for (const entry of targets) {
            if (record.status !== 'waiting') break;
            if (record.deliveries.some((delivery) => delivery.scope === entry.scopeId)) continue;
            const token = randomBytes(24).toString('hex');
            const chatId = entry.scopeId.split(':')[0]!;
            const pushedStatus = record.status;
            const sent = await sendManagedCard(deps.channel, chatId,
              codexInputCard(record.request, token, pushedStatus), target);
            record.deliveries.push({ scope: entry.scopeId, token, ...sent, sequence: 0, lastStatus: pushedStatus });
            await persist();
          }
          await persist();
          await render(record);
        } finally { deliveryQueued.delete(key); }
      });
    },
    resolve(threadId, requestId, source) {
      for (const [key, input] of live) {
        if (input.source === source && input.prompt.request.threadId === threadId && input.prompt.requestId === requestId) end(key, 'resolved');
      }
    },
    endTurn(threadId, turnId) {
      for (const [key, record] of stored) if (record.request.threadId === threadId && record.request.turnId === turnId) end(key, 'resolved');
    },
    isWaiting(threadId, turnId) {
      return [...stored.values()].some((record) => record.request.threadId === threadId && record.request.turnId === turnId &&
        record.request.isBlocking && (record.status === 'waiting' || record.status === 'disconnected'));
    },
    async handleAction(scope, messageId, token, form) {
      const recordEntry = [...stored.entries()].find(([, record]) => record.deliveries.some((delivery) =>
        delivery.scope === scope && delivery.messageId === messageId && delivery.token === token));
      if (!recordEntry) throw new Error('选项卡不存在或不属于当前群');
      const [key, record] = recordEntry;
      if (!bindings(record.request.threadId).some((entry) => entry.scopeId === scope)) throw new Error('群已不再绑定此会话');
      if (record.status !== 'waiting' || !live.has(key)) throw new Error('问题已回答、失效或正在重连，请刷新后重试');
      const answers = codexAnswersFromForm(record.request, form ?? {});
      // Synchronous reservation: simultaneous colleague clicks cannot both win.
      const input = live.get(key)!;
      record.status = record.request.kind === 'async' ? 'submitting' : 'submitted';
      live.delete(key);
      try {
        // Async delivery must survive a restart between sending and receiving
        // its acknowledgement without automatically submitting it twice.
        if (record.request.kind === 'async') await enqueue(persist);
        const sent = await input.prompt.respond(answers);
        if (!sent) record.status = 'resolved';
        else if (record.request.kind === 'async') record.status = 'submitted';
      } catch (err) {
        if (record.request.kind === 'async' && record.status === 'resolved') {
          // Completion/another client's answer may arrive while the RPC is in flight.
        } else {
          record.status = err instanceof CodexAsyncAnswerUnconfirmedError ? 'unconfirmed' : 'disconnected';
          if (record.request.kind === 'async' && record.status === 'disconnected' && !stopped) live.set(key, input);
        }
        void enqueue(async () => { await persist(); await render(record); });
        throw err;
      }
      void enqueue(async () => {
        await persist();
        // CardKit's client holds submitted form UI briefly; don't let an
        // immediate replacement be reverted by the original callback response.
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await render(record);
      });
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await reader?.stop();
      await tail;
      await persist();
    },
  };
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { version?: number; entries?: unknown[] };
    if (raw.version === 1 && Array.isArray(raw.entries)) for (const value of raw.entries) {
      if (!Array.isArray(value) || typeof value[0] !== 'string') continue;
      const record = value[1] as StoredInput;
      const request = parseCodexInputRequest(record?.request);
      if (!request || !Array.isArray(record.deliveries)) continue;
      if (!record.deliveries.every((d) => typeof d.scope === 'string' && typeof d.token === 'string' &&
        typeof d.cardId === 'string' && typeof d.messageId === 'string' && Number.isSafeInteger(d.sequence))) continue;
      stored.set(codexInputKey(request), { ...record, request,
        status: record.status === 'submitted' || record.status === 'resolved' || record.status === 'unconfirmed' ? record.status
          : request.kind === 'async' && record.status === 'submitting' ? 'unconfirmed' : 'disconnected' });
    }
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.fail('codex-input', err, { step: 'load' }); }
  const codex = deps.controls.profileConfig.codex;
  const reader = codex?.binaryPath ? (deps.readerFactory ?? ((options) => new CodexThreadReader(options)))({
    binary: codex.binaryPath, profileStateDir: deps.profileStateDir,
    codexHome: codex.codexHome, inheritCodexHome: codex.inheritCodexHome,
    sharedServer: true, passive: true, remote: process.env.CODEX_QUEUE_REMOTE, timeoutMs: 5000,
    onUserInput: (prompt) => handle.accept(prompt, 'shared'),
    onNotification(method, params) {
      if (method === 'serverRequest/resolved' && typeof params.threadId === 'string' &&
        (typeof params.requestId === 'number' || typeof params.requestId === 'string')) handle.resolve(params.threadId, params.requestId, 'shared');
      if (method === 'turn/completed' && typeof params.threadId === 'string' && params.turn && typeof params.turn === 'object') {
        const turnId = (params.turn as { id?: unknown }).id;
        if (typeof turnId === 'string') handle.endTurn(params.threadId, turnId);
      }
    },
    onDisconnect() {
      for (const [key, input] of live) if (input.source === 'shared') end(key, 'disconnected');
    },
  }) : undefined;
  const poll = async () => {
    if (stopped || watcherRunning) return;
    // Retry question delivery independently of shared endpoint availability.
    for (const input of live.values()) handle.accept(input.prompt, input.source, input.target);
    for (const [key, record] of stored) if (!deliveryQueued.has(key) &&
      record.deliveries.some((delivery) => delivery.lastStatus !== record.status)) {
      deliveryQueued.add(key);
      void enqueue(async () => { try { await render(record); } finally { deliveryQueued.delete(key); } });
    }
    if (!reader || Date.now() < retryAt) return;
    watcherRunning = true;
    try {
      const threads = new Set(deps.sessionCatalog.entries().filter((entry) =>
        entry.status === 'active' && entry.agentId === 'codex' && entry.threadId &&
        (!entry.botAppId || entry.botAppId === deps.controls.profileConfig.accounts.app.id)).map((entry) => entry.threadId!));
      for (const threadId of threads) {
        if (stopped) break;
        if ((retryThreadAt.get(threadId) ?? 0) > Date.now()) continue;
        // No independent thread/resume fallback: it would compete with App.
        try { await reader.watchLoadedThread(threadId); }
        catch (error) {
          if (!/not found|does not exist|no rollout/i.test(String(error))) throw error;
          // A stale/archived binding must not starve all other subscriptions.
          retryThreadAt.set(threadId, Date.now() + 60_000);
        }
        const orphaned = [...stored.entries()].filter(([, record]) =>
          record.request.threadId === threadId && record.status === 'disconnected');
        if (orphaned.length && reader.readThreadStatus) {
          const status = await reader.readThreadStatus(threadId);
          for (const [key, record] of orphaned) {
            // A pending request answered while offline will not be replayed.
            // Use live daemon status, never the notLoaded history projection.
            if (status?.type === 'idle' || (status?.type === 'active' && record.request.isBlocking &&
              Array.isArray(status.activeFlags) && !status.activeFlags.includes('waitingOnUserInput'))) end(key, 'resolved');
          }
        }
      }
    } catch (err) {
      retryAt = Date.now() + 15_000;
      if (Date.now() - lastWarning > 60_000) {
        lastWarning = Date.now();
        log.warn('codex-input', 'shared-listener-unavailable', { error: String(err),
          message: 'Fresh bridge requests remain interactive; desktop requests require a shared writer endpoint' });
      }
    } finally { watcherRunning = false; }
  };
  const timer = setInterval(() => void poll(), deps.intervalMs ?? 2000);
  timer.unref?.();
  // Old cards immediately lose active controls; replay reuses their identity.
  for (const record of stored.values()) if (record.status === 'disconnected') void enqueue(() => render(record));
  void poll();
  return handle;
}
