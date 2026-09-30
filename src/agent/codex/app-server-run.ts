import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import {
  mergeProcessEnv,
  type SpawnedProcessByStdio,
} from '../../platform/spawn';
import { spawnCodexProcess as spawnProcess } from '../../platform/codex-binary';
import type { AgentEvent, AgentRun } from '../types';

type CodexChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CodexAppServerRunOptions {
  runId: string;
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome: boolean;
  cwd: string;
  sandbox: SandboxMode;
  prompt: string;
  developerInstructions?: string;
  clientUserMessageId: string;
  images?: readonly string[];
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  env?: NodeJS.ProcessEnv;
  stopGraceMs: number;
}

const INITIALIZE_REQUEST_ID = 1;
const THREAD_START_REQUEST_ID = 2;
const TURN_START_REQUEST_ID = 3;
const TURN_INTERRUPT_REQUEST_ID = 4;

/**
 * Run a fresh Codex thread through app-server instead of `codex exec`.
 *
 * The desktop-bundled Codex binary records app-server threads as Desktop
 * threads (`source: vscode`), so they are discoverable in the Codex app
 * sidebar while remaining ordinary durable Codex sessions on disk.
 */
export function createCodexAppServerRun(options: CodexAppServerRunOptions): AgentRun {
  const child = spawnProcess(options.binary, ['app-server', '--listen', 'stdio://'], {
    cwd: options.cwd,
    env: appServerEnv(options),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as CodexChild;
  const stderrChunks: Buffer[] = [];
  let stderrBuffer = '';
  let threadId: string | undefined;
  let turnId: string | undefined;
  let stopRequested = false;
  let terminal = false;
  let started = false;
  let lastError: string | undefined;

  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
    stderrBuffer += chunk.toString('utf8');
    let newline = stderrBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = stderrBuffer.slice(0, newline).trim();
      stderrBuffer = stderrBuffer.slice(newline + 1);
      if (line) log.warn('agent', 'app-server-stderr', { line: line.slice(0, 1000) });
      newline = stderrBuffer.indexOf('\n');
    }
  });
  child.once('error', (err) => {
    lastError = err.message;
  });
  child.once('exit', (code, signal) => {
    log.info('agent', 'app-server-exit', { pid: child.pid ?? null, code, signal });
  });

  log.info('agent', 'app-server-spawn', {
    pid: child.pid ?? null,
    cwd: options.cwd,
    promptChars: options.prompt.length,
    images: options.images?.length ?? 0,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  });

  const events = (async function* (): AsyncGenerator<AgentEvent> {
    started = true;
    if (!child.pid) {
      terminal = true;
      yield terminalError(lastError ? `failed to spawn codex app-server: ${lastError}` : 'spawn returned no pid');
      return;
    }

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const messageDeltaItems = new Set<string>();
    const startedToolItems = new Set<string>();
    let latestUsage: AgentEvent | undefined;

    try {
      writeRequest(child, initializeRequest());

      for await (const line of rl) {
        const message = parseRecord(line);
        if (!message) continue;

        if (message.id === INITIALIZE_REQUEST_ID) {
          if (message.error) {
            terminal = true;
            yield terminalError(responseError(message, 'codex app-server initialize failed'));
            return;
          }
          writeRequest(child, { method: 'initialized' });
          writeRequest(child, threadStartRequest(options));
          continue;
        }

        if (message.id === THREAD_START_REQUEST_ID) {
          if (message.error) {
            terminal = true;
            yield terminalError(responseError(message, 'codex app-server thread/start failed'));
            return;
          }
          threadId = nestedString(message, ['result', 'thread', 'id']);
          if (!threadId) {
            terminal = true;
            yield terminalError('codex app-server thread/start returned no thread id');
            return;
          }
          yield {
            type: 'system', threadId, cwd: options.cwd,
            model: nestedString(message, ['result', 'model']) ?? options.model,
            reasoningEffort: nestedString(message, ['result', 'reasoningEffort']) ?? options.reasoningEffort,
          };
          writeRequest(child, turnStartRequest(options, threadId));
          continue;
        }

        if (message.id === TURN_START_REQUEST_ID) {
          if (message.error) {
            terminal = true;
            yield terminalError(responseError(message, 'codex app-server turn/start failed'));
            return;
          }
          turnId = nestedString(message, ['result', 'turn', 'id']) ?? turnId;
          continue;
        }

        if (typeof message.method !== 'string') continue;
        const params = recordValue(message.params);

        if (message.id !== undefined) {
          if (handleServerRequest(child, message)) continue;
        }

        switch (message.method) {
          case 'turn/started':
            turnId = stringValue(recordValue(params?.turn)?.id) ?? turnId;
            break;
          case 'item/agentMessage/delta': {
            if (!belongsToTurn(params, threadId, turnId)) break;
            const itemId = stringValue(params?.itemId);
            const delta = stringValue(params?.delta);
            if (itemId) messageDeltaItems.add(itemId);
            if (delta) yield { type: 'text', delta };
            break;
          }
          case 'item/reasoning/summaryTextDelta':
          case 'item/reasoning/textDelta': {
            if (!belongsToTurn(params, threadId, turnId)) break;
            const delta = stringValue(params?.delta);
            if (delta) yield { type: 'thinking', delta };
            break;
          }
          case 'item/started': {
            if (!belongsToTurn(params, threadId, turnId)) break;
            const item = recordValue(params?.item);
            const tool = toolStartedEvent(item);
            if (tool) {
              startedToolItems.add(tool.id);
              yield tool;
            }
            break;
          }
          case 'item/completed': {
            if (!belongsToTurn(params, threadId, turnId)) break;
            const item = recordValue(params?.item);
            const itemId = stringValue(item?.id);
            if (item?.type === 'agentMessage') {
              if (!itemId || !messageDeltaItems.has(itemId)) {
                const text = stringValue(item.text);
                if (text) yield { type: 'text', delta: text };
              }
              break;
            }
            const result = toolCompletedEvent(item, startedToolItems);
            if (result) yield result;
            break;
          }
          case 'thread/tokenUsage/updated': {
            if (!belongsToTurn(params, threadId, turnId)) break;
            const last = recordValue(recordValue(params?.tokenUsage)?.last);
            if (last) {
              latestUsage = {
                type: 'usage',
                inputTokens: numberValue(last.inputTokens),
                outputTokens: numberValue(last.outputTokens),
                cachedInputTokens: numberValue(last.cachedInputTokens),
                reasoningOutputTokens: numberValue(last.reasoningOutputTokens),
              };
            }
            break;
          }
          case 'error': {
            if (!belongsToTurn(params, threadId, turnId)) break;
            const error = recordValue(params?.error);
            lastError = stringValue(error?.message) ?? 'codex turn failed';
            if (params?.willRetry === true) {
              log.warn('agent', 'app-server-retrying', { threadId, turnId, message: lastError });
            }
            break;
          }
          case 'turn/completed': {
            if (!belongsToTurn(params, threadId, turnId)) break;
            const turn = recordValue(params?.turn);
            const status = stringValue(turn?.status);
            terminal = true;
            if (latestUsage) yield latestUsage;
            if (status === 'completed') {
              yield { type: 'done', threadId, terminationReason: 'normal' };
            } else if (status === 'interrupted' || stopRequested) {
              yield { type: 'done', threadId, terminationReason: 'interrupted' };
            } else {
              const turnError = recordValue(turn?.error);
              yield terminalError(stringValue(turnError?.message) ?? lastError ?? 'codex turn failed');
            }
            return;
          }
          default:
            break;
        }
      }
    } catch (err) {
      if (!terminal) {
        terminal = true;
        yield terminalError(`codex app-server runtime error: ${errorMessage(err)}`);
      }
      return;
    } finally {
      rl.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }

    if (!terminal) {
      terminal = true;
      if (stopRequested) {
        yield { type: 'done', threadId, terminationReason: 'interrupted' };
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        const detail = lastError ?? (stderr ? stderr.slice(0, 500) : undefined);
        yield terminalError(`codex app-server exited before turn completion${detail ? `: ${detail}` : ''}`);
      }
    }
  })();

  return {
    runId: options.runId,
    events,
    async stop() {
      if (terminal || child.exitCode !== null || child.signalCode !== null) return;
      stopRequested = true;
      if (threadId && turnId) {
        try {
          writeRequest(child, {
            method: 'turn/interrupt',
            id: TURN_INTERRUPT_REQUEST_ID,
            params: { threadId, turnId },
          });
        } catch {
          child.kill('SIGTERM');
        }
      } else {
        child.kill('SIGTERM');
      }
      const exited = await waitForExit(child, options.stopGraceMs);
      if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
    waitForExit(timeoutMs: number): Promise<boolean> {
      if (!started && child.exitCode !== null) return Promise.resolve(true);
      return waitForExit(child, timeoutMs);
    },
  };
}

function initializeRequest(): object {
  return {
    method: 'initialize',
    id: INITIALIZE_REQUEST_ID,
    params: {
      clientInfo: {
        name: 'lark-channel-bridge',
        title: 'Lark Channel Bridge',
        version: '0.5.7',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    },
  };
}

function threadStartRequest(options: CodexAppServerRunOptions): object {
  return {
    method: 'thread/start',
    id: THREAD_START_REQUEST_ID,
    params: {
      cwd: options.cwd,
      approvalPolicy: 'never',
      sandbox: options.sandbox,
      historyMode: 'paginated',
      threadSource: 'lark-channel-bridge',
      ...(options.developerInstructions
        ? { developerInstructions: options.developerInstructions }
        : {}),
      ...(options.model ? { model: options.model } : {}),
      config: {
        shell_environment_policy: { inherit: 'all' },
      },
    },
  };
}

function turnStartRequest(
  options: CodexAppServerRunOptions,
  threadId: string,
): object {
  return {
    method: 'turn/start',
    id: TURN_START_REQUEST_ID,
    params: {
      threadId,
      cwd: options.cwd,
      approvalPolicy: 'never',
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
      clientUserMessageId: options.clientUserMessageId,
      input: [
        { type: 'text', text: options.prompt, text_elements: [] },
        ...(options.images ?? []).map((path) => ({ type: 'localImage', path })),
      ],
    },
  };
}

function handleServerRequest(child: CodexChild, message: Record<string, unknown>): boolean {
  const id = message.id;
  if (id === undefined || typeof message.method !== 'string') return false;
  switch (message.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      writeRequest(child, { id, result: { decision: 'accept' } });
      return true;
    case 'currentTime/read':
      writeRequest(child, { id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return true;
    case 'mcpServer/elicitation/request':
      writeRequest(child, { id, result: { action: 'decline', content: null, _meta: null } });
      return true;
    default:
      writeRequest(child, {
        id,
        error: {
          code: -32601,
          message: `app-server request ${message.method} is not supported by lark-channel-bridge`,
        },
      });
      return true;
  }
}

function toolStartedEvent(
  item: Record<string, unknown> | undefined,
): Extract<AgentEvent, { type: 'tool_use' }> | undefined {
  const id = stringValue(item?.id);
  if (!id) return undefined;
  if (item?.type === 'commandExecution') {
    return {
      type: 'tool_use',
      id,
      name: 'command_execution',
      input: { command: stringValue(item.command) ?? '' },
    };
  }
  if (item?.type === 'mcpToolCall') {
    return {
      type: 'tool_use',
      id,
      name: `${stringValue(item.server) ?? 'mcp'}.${stringValue(item.tool) ?? 'tool'}`,
      input: item.arguments,
    };
  }
  if (item?.type === 'fileChange') {
    return { type: 'tool_use', id, name: 'file_change', input: item.changes ?? [] };
  }
  return undefined;
}

function toolCompletedEvent(
  item: Record<string, unknown> | undefined,
  startedItems: Set<string>,
): Extract<AgentEvent, { type: 'tool_result' }> | undefined {
  const id = stringValue(item?.id);
  if (!id) return undefined;
  if (item?.type === 'commandExecution') {
    startedItems.delete(id);
    const exitCode = numberValue(item.exitCode);
    return {
      type: 'tool_result',
      id,
      output: stringValue(item.aggregatedOutput) ?? '',
      isError: exitCode !== undefined && exitCode !== 0,
    };
  }
  if (item?.type === 'mcpToolCall') {
    startedItems.delete(id);
    return {
      type: 'tool_result',
      id,
      output: jsonText(item.result ?? item.error ?? ''),
      isError: item.status === 'failed' || Boolean(item.error),
    };
  }
  if (item?.type === 'fileChange') {
    startedItems.delete(id);
    return {
      type: 'tool_result',
      id,
      output: jsonText(item.changes ?? []),
      isError: item.status === 'failed',
    };
  }
  return undefined;
}

function belongsToTurn(
  params: Record<string, unknown> | undefined,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean {
  const messageThreadId = stringValue(params?.threadId);
  const messageTurnId = stringValue(params?.turnId) ?? stringValue(recordValue(params?.turn)?.id);
  return (!threadId || !messageThreadId || messageThreadId === threadId) &&
    (!turnId || !messageTurnId || messageTurnId === turnId);
}

function appServerEnv(options: CodexAppServerRunOptions): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = { ...(options.env ?? {}) };
  if (options.codexHome) overrides.CODEX_HOME = options.codexHome;
  else if (!options.inheritCodexHome) {
    overrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  }
  return mergeProcessEnv(process.env, overrides);
}

function writeRequest(child: CodexChild, message: object): void {
  child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return recordValue(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function responseError(message: Record<string, unknown>, fallback: string): string {
  const error = recordValue(message.error);
  return stringValue(error?.message) ?? fallback;
}

function nestedString(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) current = recordValue(current)?.[key];
  return stringValue(current);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function terminalError(message: string): AgentEvent {
  return { type: 'error', message: message.slice(0, 4096), terminationReason: 'failed' };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function waitForExit(child: CodexChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}
