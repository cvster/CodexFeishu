import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import { CodexThreadReader } from '../session/codex-thread-reader';
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
    Pick<CodexThreadReader, 'watchLoadedThread' | 'stop'> & Partial<Pick<CodexThreadReader, 'readThreadStatus'>>;
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
    accept(prompt, source, target) {
      if (stopped) return;
      const allowed = bindings(prompt.request.threadId);
      const targets = target ? allowed.filter((entry) => entry.scopeId === target.scope) : allowed;
      if (!targets.length) return;
      const key = codexInputKey(prompt.request);
      const previous = stored.get(key);
      // Replay may race a response we already sent. Never resurrect it.
      if (previous?.status === 'resolved' || previous?.status === 'submitted') return;
      live.set(key, { source, prompt, target });
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
      record.status = 'submitted';
      live.delete(key);
      try {
        const sent = await input.prompt.respond(answers);
        if (!sent) record.status = 'resolved';
      } catch (err) {
        record.status = 'disconnected';
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
        status: record.status === 'submitted' || record.status === 'resolved' ? record.status : 'disconnected' });
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
