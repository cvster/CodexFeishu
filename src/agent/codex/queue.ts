import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import {
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../../platform/spawn';
import type { AgentEvent, AgentRun } from '../types';
import { buildCodexQueueArgs } from './argv';

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
  env?: NodeJS.ProcessEnv;
}

interface ThreadSnapshot {
  id: string;
  turns: ThreadTurn[];
}

interface ThreadTurn {
  id: string;
  status: string;
  error?: { message?: string } | null;
  items: ThreadItem[];
}

interface ThreadItem {
  type: string;
  id?: string;
  text?: string;
  phase?: string;
  content?: Array<{ type?: string; text?: string }>;
}

const POLL_INTERVAL_MS = 750;
const READ_TIMEOUT_MS = 5000;

/** Create an AgentRun backed by `codex queue` plus read-only thread polling. */
export function createCodexQueueRun(options: QueueRunOptions): AgentRun {
  const controller = new AbortController();
  let activeChild: CodexChild | undefined;
  let settled = false;
  let started = false;
  let settle!: () => void;
  const completed = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const events = (async function* (): AsyncGenerator<AgentEvent> {
    started = true;
    try {
      const baseline = await readThread(options, options.threadId, controller.signal);
      if (controller.signal.aborted) {
        yield interrupted(options.threadId);
        return;
      }
      const knownTurns = new Set(baseline.turns.map((turn) => turn.id));
      const queueArgs = buildCodexQueueArgs({
        cwd: options.cwd,
        sandbox: options.sandbox,
        threadId: options.threadId,
        prompt: options.prompt,
        images: options.images,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      });
      const queued = await runQueueCommand(options, queueArgs, (child) => {
        activeChild = child;
      });
      activeChild = undefined;
      if (!queued.ok) {
        yield terminalError(queued.message);
        return;
      }

      log.info('agent', 'queue-accepted', {
        threadId: options.threadId,
        queueMessageId: queued.messageId,
      });
      yield { type: 'system', threadId: options.threadId, cwd: options.cwd };

      let selectedTurnId: string | undefined;
      const emittedText = new Map<string, string>();
      let consecutiveReadFailures = 0;
      while (!controller.signal.aborted) {
        let snapshot: ThreadSnapshot;
        try {
          snapshot = await readThread(options, options.threadId, controller.signal);
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
              (turn) => !knownTurns.has(turn.id) && threadContainsPrompt(turn, options.prompt),
            );
        if (selected) {
          selectedTurnId = selected.id;
          for (const item of selected.items) {
            if (item.type !== 'agentMessage' || !item.id || !item.text) continue;
            const previous = emittedText.get(item.id) ?? '';
            if (item.text === previous) continue;
            const delta = item.text.startsWith(previous) ? item.text.slice(previous.length) : item.text;
            emittedText.set(item.id, item.text);
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
      if (controller.signal.aborted) {
        yield interrupted(options.threadId);
      } else {
        yield terminalError(`Codex queue 失败：${errorMessage(err)}`);
      }
    } finally {
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
    return { ok: false, message: `codex queue exited with code ${code ?? 'signal'}${detail ? `: ${detail}` : ''}` };
  }
  const match = /Queued message\s+([^\s]+)\s+for thread/i.exec(output);
  return { ok: true, ...(match?.[1] ? { messageId: match[1] } : {}) };
}

async function readThread(
  options: QueueRunOptions,
  threadId: string,
  signal: AbortSignal,
): Promise<ThreadSnapshot> {
  if (signal.aborted) throw new Error('aborted');
  const child = spawnProcess(options.binary, ['app-server', '--listen', 'stdio://'], {
    env: queueEnv(options),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as CodexChild;
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  return new Promise<ThreadSnapshot>((resolve, reject) => {
    let done = false;
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const finish = (result: { value?: ThreadSnapshot; error?: Error }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      rl.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (result.error) reject(result.error);
      else resolve(result.value!);
    };
    const onAbort = (): void => finish({ error: new Error('aborted') });
    const timer = setTimeout(
      () => finish({ error: new Error(`thread/read timed out after ${READ_TIMEOUT_MS}ms`) }),
      READ_TIMEOUT_MS,
    );
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (err) => finish({ error: err }));
    child.once('exit', (code) => {
      if (done) return;
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      finish({ error: new Error(`app-server exited with ${code ?? 'signal'}${detail ? `: ${detail}` : ''}`) });
    });
    rl.on('line', (line) => {
      let response: Record<string, unknown> | undefined;
      try {
        response = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (response.id !== 2) return;
      if (response.error) {
        const error = response.error as { message?: string };
        finish({ error: new Error(error.message ?? 'thread/read rejected') });
        return;
      }
      const result = response.result as { thread?: unknown } | undefined;
      const parsed = normalizeThread(result?.thread);
      if (!parsed) {
        finish({ error: new Error('thread/read returned malformed data') });
        return;
      }
      finish({ value: parsed });
    });
    child.stdin.write(
      `${JSON.stringify(initializeRequest())}\n${JSON.stringify({
        method: 'thread/read',
        id: 2,
        params: { threadId, includeTurns: true },
      })}\n`,
      'utf8',
    );
  });
}

function normalizeThread(input: unknown): ThreadSnapshot | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as { id?: unknown; turns?: unknown };
  if (typeof raw.id !== 'string' || !Array.isArray(raw.turns)) return undefined;
  const turns: ThreadTurn[] = [];
  for (const item of raw.turns) {
    if (!item || typeof item !== 'object') continue;
    const turn = item as { id?: unknown; status?: unknown; error?: unknown; items?: unknown };
    if (typeof turn.id !== 'string' || typeof turn.status !== 'string' || !Array.isArray(turn.items)) continue;
    turns.push({
      id: turn.id,
      status: turn.status,
      error: turn.error && typeof turn.error === 'object' ? (turn.error as { message?: string }) : null,
      items: turn.items as ThreadItem[],
    });
  }
  return { id: raw.id, turns };
}

function threadContainsPrompt(turn: ThreadTurn, prompt: string): boolean {
  return turn.items.some(
    (item) =>
      item.type === 'userMessage' &&
      item.content?.some((content) => content.type === 'text' && content.text === prompt),
  );
}

function queueEnv(options: QueueRunOptions): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = { ...(options.env ?? {}) };
  if (options.codexHome) overrides.CODEX_HOME = options.codexHome;
  else if (!options.inheritCodexHome) overrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  return mergeProcessEnv(process.env, overrides);
}

function initializeRequest(): object {
  return {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'lark-channel-bridge',
        title: 'Lark Channel Bridge Queue Monitor',
        version: '0.5.7',
      },
      capabilities: null,
    },
  };
}

function childExit(child: CodexChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
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
