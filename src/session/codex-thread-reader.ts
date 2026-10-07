import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import { Duplex, type Readable, type Writable } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import { nextCodexForkName } from './codex-fork-name';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCodexInputRequest, type CodexInputPrompt, type CodexRequestId } from './codex-user-input';
import { CodexAsyncAnswerUnconfirmedError } from './codex-async-input';
import {
  mergeProcessEnv,
  type SpawnedProcessByStdio,
} from '../platform/spawn';
import { spawnCodexProcess as spawnProcess } from '../platform/codex-binary';
import {
  CodexTurnTerminalVerifier,
  type CodexPersistedTurnTerminal,
} from './codex-turn-terminal';

type CodexChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CodexThreadItem extends Record<string, unknown> {
  id?: string;
  type?: string;
}

export interface CodexThreadTurn {
  id: string;
  status: string;
  startedAtMs?: number;
  completedAtMs?: number | null;
  error?: { message?: string };
  items: CodexThreadItem[];
  model?: string;
  reasoningEffort?: string;
}

export interface CodexThreadSnapshot {
  id: string;
  name?: string;
  status?: { type: string; activeFlags?: string[] };
  rolloutPath?: string;
  updatedAtMs?: number;
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
  /** Connect to the writer's shared daemon, never an independent app-server. */
  sharedServer?: boolean;
  remote?: string;
  /** A subscribed observer must never auto-approve another client's tools. */
  passive?: boolean;
  onUserInput?(prompt: CodexInputPrompt): void;
  onNotification?(method: string, params: Record<string, unknown>): void;
  onDisconnect?(): void;
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class CodexRpcError extends Error {}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Reusable stdio client for Codex app-server. A single process serves every
 * bound thread so desktop-turn discovery does not spawn one Codex process per
 * thread and poll interval. The client is self-healing: the next read starts a
 * fresh app-server after an unexpected exit.
 */
export class CodexThreadReader {
  private child: CodexChild | undefined;
  private socket: WebSocket | undefined;
  private rl: ReadLineInterface | undefined;
  private starting: Promise<void> | undefined;
  private nextRequestId = 2;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly terminalVerifier = new CodexTurnTerminalVerifier();
  private stopped = false;
  private generation = 0;
  private readonly inputs = new Set<CodexRequestId>();
  private readonly joined = new Set<string>();

  constructor(private readonly options: CodexThreadReaderOptions) {}

  async readThreadStatus(threadId: string): Promise<{ type: string; activeFlags?: string[] } | undefined> {
    if (!this.options.sharedServer) throw new Error('Live status requires the writer daemon');
    await this.ensureStarted();
    const response = await this.request('thread/read', { threadId, includeTurns: false });
    const status = recordValue(recordValue(recordValue(response.result)?.thread)?.status);
    if (typeof status?.type !== 'string') return;
    return { type: status.type, ...(Array.isArray(status.activeFlags)
      ? { activeFlags: status.activeFlags.filter((value): value is string => typeof value === 'string') } : {}) };
  }

  /** Rejoin ONLY an already-loaded thread in the SAME daemon. No overrides. */
  async watchLoadedThread(threadId: string): Promise<boolean> {
    if (!this.options.sharedServer) throw new Error('Interactive subscription requires the writer daemon');
    await this.ensureStarted();
    if (this.joined.has(threadId)) return true;
    const status = await this.readThreadStatus(threadId);
    if (status?.type !== 'active') return false;
    await this.request('thread/resume', { threadId, excludeTurns: true });
    this.joined.add(threadId);
    return true;
  }

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
    const executions = await this.terminalVerifier.executionsFor(thread.rolloutPath);
    return {
      ...thread,
      turns: thread.turns.map((turn) => ({ ...turn, ...executions.get(turn.id) })),
    };
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

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    if (this.stopped) return;
    await this.ensureStarted();
    await this.request('turn/interrupt', { threadId, turnId });
  }

  /** Never resume/queue as a fallback: answers belong to this already-active turn. */
  async steerTurn(threadId: string, expectedTurnId: string, text: string): Promise<void> {
    if (!this.options.sharedServer) throw new Error('Steering requires the writer app-server');
    if (!expectedTurnId) throw new Error('expectedTurnId is required');
    await this.ensureStarted();
    try {
      const response = await this.request('turn/steer', {
        threadId, expectedTurnId, clientUserMessageId: `lark-channel-bridge:async:${randomUUID()}`,
        input: [{ type: 'text', text, text_elements: [] }],
      });
      if (recordValue(response.result)?.turnId !== expectedTurnId) throw new CodexAsyncAnswerUnconfirmedError();
    } catch (error) {
      if (error instanceof CodexRpcError) throw error; // Explicit server rejection: not delivered.
      throw new CodexAsyncAnswerUnconfirmedError(); // Any transport loss after sending is ambiguous.
    }
  }

  async deleteQueuedTurn(threadId: string, queuedSubmissionId: string): Promise<void> {
    if (this.stopped) return;
    await this.ensureStarted();
    await this.request('thread/queue/delete', { threadId, queuedSubmissionId });
  }

  async updateThreadSettings(
    threadId: string,
    settings: { model?: string; reasoningEffort?: string },
  ): Promise<void> {
    if (!this.options.sharedServer) throw new Error('Thread settings require the shared Codex daemon');
    await this.ensureStarted();
    const params = {
      threadId,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.reasoningEffort ? { effort: settings.reasoningEffort } : {}),
    };
    try {
      await this.request('thread/settings/update', params);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('thread not found:')) throw error;
      // Load dormant history only in the SAME writer daemon. Never fall back
      // to resuming through the read-only/embedded server and competing with App.
      await this.request('thread/resume', { threadId });
      await this.request('thread/settings/update', params);
    }
  }

  async forkThread(threadId: string): Promise<{ threadId: string; name: string; cwd: string }> {
    if (this.stopped) throw new Error('Codex thread reader is stopped');
    await this.ensureStarted();
    const sourceResponse = await this.request('thread/read', { threadId, includeTurns: false });
    const source = recordValue(recordValue(sourceResponse.result)?.thread);
    const sourceName = stringValue(source?.name)?.trim() || 'Codex会话';
    const response = await this.request('thread/fork', {
      threadId,
      excludeTurns: true,
      deferGoalContinuation: true,
    });
    const result = recordValue(response.result);
    const fork = recordValue(result?.thread);
    const forkId = stringValue(fork?.id);
    const cwd = stringValue(fork?.cwd) ?? stringValue(result?.cwd) ?? stringValue(source?.cwd);
    if (!forkId || !cwd) throw new Error('thread/fork returned malformed thread metadata');
    let name = stringValue(fork?.name)?.trim();
    if (!name || name === sourceName) {
      const names: string[] = [];
      const base = sourceName.replace(/\s+\(\d+\)$/, '');
      for (const archived of [false, true]) {
        let cursor: string | undefined;
        do {
          const listed = await this.request('thread/list', {
            limit: 100, searchTerm: base, archived, ...(cursor ? { cursor } : {}),
          });
          const page = recordValue(listed.result);
          if (!Array.isArray(page?.data)) throw new Error('thread/list returned malformed data for fork naming');
          for (const value of page.data) {
            const title = stringValue(recordValue(value)?.name);
            if (title) names.push(title);
          }
          cursor = stringValue(page.nextCursor);
        } while (cursor);
      }
      name = nextCodexForkName(sourceName, names);
      await this.request('thread/name/set', { threadId: forkId, name });
    }
    return { threadId: forkId, name, cwd };
  }

  /** Create idle persisted history only. Task execution belongs to the writer. */
  async createIdleThread(options: { cwd: string; sandbox: string; model?: string; reasoningEffort?: string; developerInstructions?: string }): Promise<string> {
    await this.ensureStarted();
    const response = await this.request('thread/start', {
      cwd: options.cwd, approvalPolicy: 'never', sandbox: options.sandbox,
      historyMode: 'legacy', threadSource: 'lark-channel-bridge',
      ...(options.model ? { model: options.model } : {}),
      ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
      config: { shell_environment_policy: { inherit: 'all' },
        ...(options.reasoningEffort ? { model_reasoning_effort: options.reasoningEffort } : {}) },
    });
    const id = stringValue(recordValue(recordValue(response.result)?.thread)?.id);
    if (!id) throw new Error('thread/start returned no thread id');
    // A metadata update materializes lazy idle history without starting any
    // model turn. Validate it before closing the creator. The standalone CLI
    // store does not implement paginated list_turns on all supported builds.
    await this.request('thread/name/set', { threadId: id, name: 'Codex会话' });
    await this.readThread(id);
    return id;
  }

  async persistedTurnTerminal(
    snapshot: CodexThreadSnapshot,
    turnId: string,
  ): Promise<CodexPersistedTurnTerminal | undefined> {
    return this.terminalVerifier.terminalFor(snapshot.rolloutPath, turnId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.reset(new Error('Codex thread reader stopped'));
    if (child && child.exitCode === null && child.signalCode === null) {
      // The next queue client may open the same store immediately. Wait for
      // this owned read/creator process to release its SQLite resources.
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.stopped) throw new Error('Codex thread reader is stopped');
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return;
    if (this.starting) return this.starting;
    this.starting = this.startProcess().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startProcess(): Promise<void> {
    const remote = this.options.remote;
    if (this.options.sharedServer && remote && !/^(unix|wss?):\/\//.test(remote)) {
      throw new Error('Unsupported shared Codex endpoint');
    }
    if (this.options.sharedServer && remote && /^wss?:\/\//.test(remote)) {
      await this.startSharedSocket(new WebSocket(remote, { handshakeTimeout: DEFAULT_TIMEOUT_MS }));
      return;
    }
    const args = this.options.sharedServer
      ? ['app-server', 'proxy', ...(remote && remote !== 'unix://' ? ['--sock', remote.slice(7)] : [])]
      : ['app-server', '--listen', 'stdio://'];
    const child = spawnProcess(this.options.binary, args, {
      env: readerEnv(this.options),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as CodexChild;
    this.child = child;
    // Always drain stderr so a chatty app-server cannot block on a full pipe.
    child.stderr.on('data', () => {});
    child.stdin.on('error', (err) => { if (this.child === child) this.handleExit(err); });
    child.once('error', (err) => { if (this.child === child) this.handleExit(err); });
    child.once('exit', (code, signal) => {
      if (this.child === child) this.handleExit(new Error(`codex app-server exited with ${code ?? signal ?? 'unknown'}`));
    });

    if (this.options.sharedServer) {
      // `proxy` relays raw socket bytes. The control socket speaks WebSocket,
      // not JSONL; use Codex's cross-platform relay for Windows Unix sockets.
      const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
      await this.startSharedSocket(new WebSocket('ws://localhost/', {
        createConnection: () => stream as Socket,
        handshakeTimeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }));
      return;
    }
    this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));

    await this.initialize();
  }

  private async startSharedSocket(socket: WebSocket): Promise<void> {
    this.socket = socket;
    socket.on('message', (data) => this.handleLine(data.toString()));
    socket.on('error', (error) => { if (this.socket === socket) this.abortCurrentProcess(error); });
    socket.on('close', () => { if (this.socket === socket) this.handleExit(new Error('Shared Codex connection closed')); });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('Shared Codex connection closed before initialization')));
    });
    await this.initialize();
  }

  private async initialize(): Promise<void> {
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
      throw new CodexRpcError(stringValue(error?.message) ?? `${method} rejected`);
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
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
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
    if (typeof message.method === 'string') {
      const params = recordValue(message.params) ?? {};
      if (message.method === 'serverRequest/resolved' &&
        (typeof params.requestId === 'string' || typeof params.requestId === 'number')) this.inputs.delete(params.requestId);
      this.options.onNotification?.(message.method, params);
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
    if (message.method === 'item/tool/requestUserInput' && this.options.onUserInput &&
      (typeof id === 'string' || typeof id === 'number')) {
      const request = parseCodexInputRequest(message.params);
      if (!request) return; // A passive observer must not reject another client's request.
      const generation = this.generation;
      this.inputs.add(id);
      this.options.onUserInput({ requestId: id, request, respond: async (answers) => {
        if (generation !== this.generation || !this.inputs.delete(id)) return false;
        this.write({ id, result: { answers } });
        return true;
      } });
      return;
    }
    if (this.options.passive && message.method !== 'currentTime/read') return;
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
    this.generation++;
    this.inputs.clear();
    this.joined.clear();
    this.options.onDisconnect?.();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners('close');
      socket.terminate();
    }
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
  const status = recordValue(raw.status);
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
      ...(typeof turn.model === 'string' ? { model: turn.model } : {}),
      ...(typeof turn.reasoningEffort === 'string' ? { reasoningEffort: turn.reasoningEffort } : {}),
      ...(typeof turn.startedAt === 'number' ? { startedAtMs: Math.round(turn.startedAt * 1000) } : {}),
      ...(turn.completedAt === null
        ? { completedAtMs: null }
        : typeof turn.completedAt === 'number'
          ? { completedAtMs: Math.round(turn.completedAt * 1000) }
          : {}),
      items: turn.items.filter((item): item is CodexThreadItem => Boolean(recordValue(item))),
      ...(error ? { error: { ...(typeof error.message === 'string' ? { message: error.message } : {}) } } : {}),
    });
  }
  return {
    id: raw.id,
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof status?.type === 'string' ? { status: { type: status.type,
      ...(Array.isArray(status.activeFlags)
        ? { activeFlags: status.activeFlags.filter((value): value is string => typeof value === 'string') } : {}) } } : {}),
    ...(typeof raw.path === 'string' ? { rolloutPath: raw.path } : {}),
    ...(typeof raw.updatedAt === 'number' ? { updatedAtMs: Math.round(raw.updatedAt * 1000) } : {}),
    turns,
  };
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
