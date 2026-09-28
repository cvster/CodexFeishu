import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import {
  CodexThreadReader,
  type CodexThreadItem,
  type CodexThreadSnapshot,
  type CodexThreadTurn,
} from '../../session/codex-thread-reader';
import type { AgentEvent, AgentRun } from '../types';

interface QueueRunOptions {
  runId: string;
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome: boolean;
  cwd: string;
  sandbox: SandboxMode;
  threadId: string;
  prompt: string;
  images?: readonly string[];
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  clientUserMessageId: string;
  env?: NodeJS.ProcessEnv;
}

const POLL_INTERVAL_MS = 750;

/** Create an AgentRun backed by app-server's durable thread queue. */
export function createCodexQueueRun(options: QueueRunOptions): AgentRun {
  const controller = new AbortController();
  const reader = new CodexThreadReader({
    binary: options.binary,
    profileStateDir: options.profileStateDir,
    ...(options.codexHome ? { codexHome: options.codexHome } : {}),
    inheritCodexHome: options.inheritCodexHome,
    env: options.env,
  });
  let selectedTurnId: string | undefined;
  let queuedSubmissionId: string | undefined;
  let settled = false;
  let started = false;
  let settle!: () => void;
  const completed = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const events = (async function* (): AsyncGenerator<AgentEvent> {
    started = true;
    try {
      const queued = await reader.queueTurn({
        threadId: options.threadId,
        cwd: options.cwd,
        sandbox: options.sandbox,
        prompt: options.prompt,
        images: options.images,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        clientUserMessageId: options.clientUserMessageId,
      });
      queuedSubmissionId = queued.queuedSubmissionId;
      selectedTurnId = queued.turnId;
      log.info('agent', 'queue-accepted', {
        threadId: options.threadId,
        queuedSubmissionId,
        clientUserMessageId: options.clientUserMessageId,
        turnId: selectedTurnId,
      });
      yield { type: 'system', threadId: options.threadId, cwd: options.cwd };

      const emittedText = new Map<string, string>();
      let consecutiveReadFailures = 0;
      while (!controller.signal.aborted) {
        let snapshot: CodexThreadSnapshot;
        try {
          snapshot = await reader.readThread(options.threadId);
          consecutiveReadFailures = 0;
        } catch (err) {
          if (controller.signal.aborted) break;
          consecutiveReadFailures += 1;
          if (consecutiveReadFailures >= 5) {
            yield terminalError(`读取 Codex 队列结果失败：${errorMessage(err)}`);
            return;
          }
          await abortableDelay(POLL_INTERVAL_MS, controller.signal);
          continue;
        }

        const selected = selectedTurnId
          ? snapshot.turns.find((turn) => turn.id === selectedTurnId)
          : snapshot.turns.find((turn) => turnHasClientId(turn, options.clientUserMessageId));
        if (selected) {
          selectedTurnId = selected.id;
          for (const item of selected.items) {
            const message = agentMessage(item);
            if (!message) continue;
            const previous = emittedText.get(message.id) ?? '';
            if (message.text === previous) continue;
            const delta = message.text.startsWith(previous)
              ? message.text.slice(previous.length)
              : message.text;
            emittedText.set(message.id, message.text);
            if (delta) yield { type: 'text', delta };
          }
          if (selected.status === 'completed') {
            yield { type: 'done', threadId: options.threadId, terminationReason: 'normal' };
            return;
          }
          if (selected.status === 'failed' || selected.status === 'cancelled') {
            yield terminalError(selected.error?.message ?? `Codex turn ${selected.status}`);
            return;
          }
        }
        await abortableDelay(POLL_INTERVAL_MS, controller.signal);
      }

      yield interrupted(options.threadId);
    } catch (err) {
      if (controller.signal.aborted) yield interrupted(options.threadId);
      else yield terminalError(`Codex queue 失败：${errorMessage(err)}`);
    } finally {
      await reader.stop();
      settled = true;
      settle();
    }
  })();

  return {
    runId: options.runId,
    events,
    async stop() {
      if (settled) return;
      if (!started) {
        settled = true;
        settle();
        return;
      }
      controller.abort();
      try {
        if (selectedTurnId) {
          await reader.interruptTurn(options.threadId, selectedTurnId);
        } else if (queuedSubmissionId) {
          await reader.deleteQueuedTurn(options.threadId, queuedSubmissionId);
        }
      } catch (err) {
        log.warn('agent', 'queue-stop-failed', {
          threadId: options.threadId,
          message: errorMessage(err),
        });
      }
      await completed;
    },
    async waitForExit(timeoutMs: number): Promise<boolean> {
      if (settled) return true;
      return Promise.race([
        completed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
    },
  };
}

function turnHasClientId(turn: CodexThreadTurn, clientUserMessageId: string): boolean {
  return turn.items.some(
    (item) => item.type === 'userMessage' && item.clientId === clientUserMessageId,
  );
}

function agentMessage(item: CodexThreadItem): { id: string; text: string } | undefined {
  return item.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string'
    ? { id: item.id, text: item.text }
    : undefined;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function interrupted(threadId: string): AgentEvent {
  return { type: 'done', threadId, terminationReason: 'interrupted' };
}

function terminalError(message: string): AgentEvent {
  return { type: 'error', message, terminationReason: 'failed' };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
