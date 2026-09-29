import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import {
  CodexThreadReader,
  type CodexThreadItem,
  type CodexThreadSnapshot,
  type CodexThreadTurn,
} from '../../session/codex-thread-reader';
import {
  isInterruptedTurnStatus,
  isProvisionalInterruptedTurn,
} from '../../session/codex-turn-status';
import {
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../../platform/spawn';
import type { AgentEvent, AgentRun } from '../types';
import { buildCodexQueueArgs } from './argv';
import {
  bindCodexQueuedTurnClaim,
  registerCodexQueuedTurnClaim,
  releaseCodexQueuedTurnClaim,
} from '../../session/codex-origin';

type CodexChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

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

/**
 * Queue follow-up input through the shared Codex daemon, then use a read-only
 * app-server client to mirror that turn back to Feishu. `codex queue` is the
 * supported multi-client entrypoint: unlike thread/resume, it does not try to
 * take the Desktop client's writer lease.
 */
export function createCodexQueueRun(options: QueueRunOptions): AgentRun {
  const controller = new AbortController();
  const reader = new CodexThreadReader({
    binary: options.binary,
    profileStateDir: options.profileStateDir,
    ...(options.codexHome ? { codexHome: options.codexHome } : {}),
    inheritCodexHome: options.inheritCodexHome,
    env: options.env,
  });
  let activeChild: CodexChild | undefined;
  let selectedTurnId: string | undefined;
  let queuedSubmissionId: string | undefined;
  let provisionalInterruptedTurnId: string | undefined;
  let settled = false;
  let started = false;
  let settle!: () => void;
  const completed = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const events = (async function* (): AsyncGenerator<AgentEvent> {
    started = true;
    try {
      const baseline = await reader.readThread(options.threadId);
      if (controller.signal.aborted) {
        yield interrupted(options.threadId);
        return;
      }
      const knownTurns = new Set(baseline.turns.map((turn) => turn.id));
      registerCodexQueuedTurnClaim(
        options.clientUserMessageId,
        options.threadId,
        options.prompt,
        knownTurns,
      );
      const queueArgs = buildCodexQueueArgs({
        cwd: options.cwd,
        sandbox: options.sandbox,
        threadId: options.threadId,
        prompt: options.prompt,
        remote: options.env?.CODEX_QUEUE_REMOTE ?? process.env.CODEX_QUEUE_REMOTE,
        images: options.images,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      });
      const queued = await runQueueCommand(options, queueArgs, (child) => {
        activeChild = child;
      });
      activeChild = undefined;
      if (!queued.ok) {
        releaseCodexQueuedTurnClaim(options.clientUserMessageId);
        yield terminalError(queued.message);
        return;
      }
      queuedSubmissionId = queued.messageId;
      log.info('agent', 'queue-accepted', {
        threadId: options.threadId,
        queueMessageId: queuedSubmissionId,
        clientUserMessageId: options.clientUserMessageId,
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
          : snapshot.turns.find(
              (turn) => !knownTurns.has(turn.id) && turnContainsPrompt(turn, options.prompt),
            );
        if (selected) {
          if (!selectedTurnId) {
            selectedTurnId = selected.id;
            bindCodexQueuedTurnClaim(options.clientUserMessageId, selected.id);
          }
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
          if (isInterruptedTurnStatus(selected.status)) {
            if (isProvisionalInterruptedTurn(snapshot, selected)) {
              if (provisionalInterruptedTurnId !== selected.id) {
                provisionalInterruptedTurnId = selected.id;
                log.info('agent', 'queue-interrupted-provisional', {
                  threadId: options.threadId,
                  turnId: selected.id,
                });
              }
              await abortableDelay(POLL_INTERVAL_MS, controller.signal);
              continue;
            }
            yield interrupted(options.threadId);
            return;
          }
          provisionalInterruptedTurnId = undefined;
          if (selected.status === 'failed') {
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
      releaseCodexQueuedTurnClaim(options.clientUserMessageId);
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
      if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
        activeChild.kill('SIGTERM');
      }
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

async function runQueueCommand(
  options: QueueRunOptions,
  args: string[],
  onChild: (child: CodexChild) => void,
): Promise<{ ok: true; messageId?: string } | { ok: false; message: string }> {
  const child = spawnProcess(options.binary, args, {
    cwd: options.cwd,
    env: queueEnv(options),
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as CodexChild;
  onChild(child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const code = await childExit(child);
  const output = Buffer.concat(stdout).toString('utf8').trim();
  if (code !== 0) {
    const detail = Buffer.concat(stderr).toString('utf8').trim() || output;
    return {
      ok: false,
      message: `codex queue exited with code ${code ?? 'signal'}${detail ? `: ${detail}` : ''}`,
    };
  }
  const match = /Queued message\s+([^\s.]+)\s+for thread/i.exec(output);
  return { ok: true, ...(match?.[1] ? { messageId: match[1] } : {}) };
}

function turnContainsPrompt(turn: CodexThreadTurn, prompt: string): boolean {
  return turn.items.some(
    (item) =>
      item.type === 'userMessage' &&
      Array.isArray(item.content) &&
      item.content.some((content) => {
        const value = recordValue(content);
        return value?.type === 'text' && value.text === prompt;
      }),
  );
}

function queueEnv(options: QueueRunOptions): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = { ...(options.env ?? {}) };
  if (options.codexHome) overrides.CODEX_HOME = options.codexHome;
  else if (!options.inheritCodexHome) overrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  return mergeProcessEnv(process.env, overrides);
}

function childExit(child: CodexChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
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

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}
