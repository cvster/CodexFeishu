import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import type { SandboxMode } from '../config/profile-schema';
import {
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../platform/spawn';

type CodexChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CodexThreadItem extends Record<string, unknown> {
  id?: string;
  type?: string;
}

export interface CodexThreadTurn {
  id: string;
  status: string;
  error?: { message?: string };
  items: CodexThreadItem[];
}

export interface CodexThreadSnapshot {
  id: string;
  turns: CodexThreadTurn[];
}

export interface CodexThreadRevision {
  id: string;
  updatedAtMs: number;
}

export interface CodexThreadReaderOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CodexQueuedTurnOptions {
  threadId: string;
  cwd: string;
  sandbox: SandboxMode;
  prompt: string;
  images?: readonly string[];
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  clientUserMessageId: string;
}

export interface CodexQueuedTurnResult {
  queuedSubmissionId: string;
  turnId?: string;
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Reusable stdio client for Codex app-server. A single process serves every
 * bound thread so desktop-turn discovery does not spawn one Codex process per
 * thread and poll interval. The client is self-healing: the next read starts a
 * fresh app-server after an unexpected exit.
 */
export class CodexThreadReader {
  private child: CodexChild | undefined;
  private rl: ReadLineInterface | undefined;
  private starting: Promise<void> | undefined;
  private nextRequestId = 2;
  private readonly pending = new Map<number, PendingRequest>();
  private stopped = false;

  constructor(private readonly options: CodexThreadReaderOptions) {}

  async readThread(threadId: string): Promise<CodexThreadSnapshot> {
    if (this.stopped) throw new Error('Codex thread reader is stopped');
    await this.ensureStarted();
    let response: Record<string, unknown>;
    try {
      response = await this.request('thread/read', {
        threadId,
        includeTurns: true,
      });
    } catch (err) {
      this.abortCurrentProcess(err);
      throw err;
    }
    const result = recordValue(response.result);
    const thread = normalizeCodexThreadSnapshot(result?.thread);
    if (!thread) throw new Error('thread/read returned malformed data');
    return thread;
  }

  async listRecentThreads(limit = 100): Promise<CodexThreadRevision[]> {
    if (this.stopped) throw new Error('Codex thread reader is stopped');
    await this.ensureStarted();
    let response: Record<string, unknown>;
    try {
      response = await this.request('thread/list', {
        limit: Math.max(1, Math.min(100, limit)),
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false,
        useStateDbOnly: true,
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
      });
    } catch (err) {
      this.abortCurrentProcess(err);
      throw err;
    }
    const result = recordValue(response.result);
    if (!result || !Array.isArray(result.data)) throw new Error('thread/list returned malformed data');
    return result.data.flatMap((value) => {
      const thread = recordValue(value);
      if (!thread || typeof thread.id !== 'string') return [];
      const updatedAt = typeof thread.updatedAt === 'number' ? thread.updatedAt : 0;
      return [{ id: thread.id, updatedAtMs: Math.round(updatedAt * 1000) }];
    });
  }

  async queueTurn(options: CodexQueuedTurnOptions): Promise<CodexQueuedTurnResult> {
    if (this.stopped) throw new Error('Codex thread reader is stopped');
    await this.ensureStarted();
    await this.request('thread/resume', {
      threadId: options.threadId,
      cwd: options.cwd,
      approvalPolicy: 'never',
      sandbox: options.sandbox,
      excludeTurns: true,
      ...(options.model ? { model: options.model } : {}),
      config: {
        shell_environment_policy: { inherit: 'all' },
        ...(options.reasoningEffort
          ? { model_reasoning_effort: options.reasoningEffort }
          : {}),
      },
    });
    const added = await this.request('thread/queue/add', {
      threadId: options.threadId,
      clientUserMessageId: options.clientUserMessageId,
      input: [
        { type: 'text', text: options.prompt, text_elements: [] },
        ...(options.images ?? []).map((path) => ({ type: 'localImage', path })),
      ],
    });
    const queued = recordValue(recordValue(added.result)?.queuedSubmission);
    const queuedSubmissionId = stringValue(queued?.id);
    if (!queuedSubmissionId) throw new Error('thread/queue/add returned no queued submission id');

    try {
      const started = await this.request('thread/queue/start', {
        threadId: options.threadId,
        queuedSubmissionId,
      });
      const turnId = stringValue(recordValue(recordValue(started.result)?.turn)?.id);
      return { queuedSubmissionId, ...(turnId ? { turnId } : {}) };
    } catch (err) {
      // A currently running turn consumes the queued submission when it
      // finishes. In that case queue/start is expected to reject, but the add
      // itself succeeded and polling will discover our exact client id later.
      if (isActiveTurnConflict(err)) return { queuedSubmissionId };
      throw err;
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    if (this.stopped) return;
    await this.ensureStarted();
    await this.request('turn/interrupt', { threadId, turnId });
  }

  async deleteQueuedTurn(threadId: string, queuedSubmissionId: string): Promise<void> {
    if (this.stopped) return;
    await this.ensureStarted();
    await this.request('thread/queue/delete', { threadId, queuedSubmissionId });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.reset(new Error('Codex thread reader stopped'));
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return;
    if (this.starting) return this.starting;
    this.starting = this.startProcess().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startProcess(): Promise<void> {
    const child = spawnProcess(this.options.binary, ['app-server', '--listen', 'stdio://'], {
      env: readerEnv(this.options),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as CodexChild;
    this.child = child;
    this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));
    // Always drain stderr so a chatty app-server cannot block on a full pipe.
    child.stderr.on('data', () => {});
    child.once('error', (err) => this.handleExit(err));
    child.once('exit', (code, signal) => {
      this.handleExit(new Error(`codex app-server exited with ${code ?? signal ?? 'unknown'}`));
    });

    try {
      const response = await this.requestRaw(1, 'initialize', {
        clientInfo: {
          name: 'lark-channel-bridge',
          title: 'Lark Channel Bridge Thread Sync',
          version: '0.5.7',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      if (response.error) {
        const error = recordValue(response.error);
        throw new Error(stringValue(error?.message) ?? 'codex app-server initialize failed');
      }
      this.write({ method: 'initialized' });
    } catch (err) {
      this.abortCurrentProcess(err);
      throw err;
    }
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = this.nextRequestId++;
    const response = await this.requestRaw(id, method, params);
    if (response.error) {
      const error = recordValue(response.error);
      throw new Error(stringValue(error?.message) ?? `${method} rejected`);
    }
    return response;
  }

  private requestRaw(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('codex app-server is not running');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown> | undefined;
    try {
      message = recordValue(JSON.parse(line));
    } catch {
      return;
    }
    if (!message) return;
    if (typeof message.method === 'string' && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    pending.resolve(message);
  }

  private handleServerRequest(message: Record<string, unknown>): void {
    const id = message.id;
    switch (message.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        this.write({ id, result: { decision: 'accept' } });
        break;
      case 'currentTime/read':
        this.write({ id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
        break;
      case 'mcpServer/elicitation/request':
        this.write({ id, result: { action: 'decline', content: null, _meta: null } });
        break;
      default:
        this.write({
          id,
          error: {
            code: -32601,
            message: `app-server request ${String(message.method)} is not supported by lark-channel-bridge`,
          },
        });
    }
  }

  private handleExit(error: Error): void {
    this.reset(error);
  }

  private abortCurrentProcess(reason: unknown): void {
    const child = this.child;
    this.reset(reason instanceof Error ? reason : new Error(String(reason)));
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }

  private reset(error: Error): void {
    this.rl?.close();
    this.rl = undefined;
    this.child?.stderr.removeAllListeners('data');
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function normalizeCodexThreadSnapshot(input: unknown): CodexThreadSnapshot | undefined {
  const raw = recordValue(input);
  if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.turns)) return undefined;
  const turns: CodexThreadTurn[] = [];
  for (const value of raw.turns) {
    const turn = recordValue(value);
    if (!turn || typeof turn.id !== 'string' || typeof turn.status !== 'string' || !Array.isArray(turn.items)) {
      continue;
    }
    const error = recordValue(turn.error);
    turns.push({
      id: turn.id,
      status: turn.status,
      items: turn.items.filter((item): item is CodexThreadItem => Boolean(recordValue(item))),
      ...(error ? { error: { ...(typeof error.message === 'string' ? { message: error.message } : {}) } } : {}),
    });
  }
  return { id: raw.id, turns };
}

function readerEnv(options: CodexThreadReaderOptions): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = { ...(options.env ?? {}) };
  if (options.codexHome) overrides.CODEX_HOME = options.codexHome;
  else if (!options.inheritCodexHome) overrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  return mergeProcessEnv(process.env, overrides);
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function isActiveTurnConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:active|running|busy|in[ -]?progress|already).*(?:turn|thread)|(?:turn|thread).*(?:active|running|busy|in[ -]?progress|already)/i.test(message);
}
