import { join } from 'node:path';
import { mergeProcessEnv } from '../platform/spawn';
import { spawnCodexProcess as spawnProcess } from '../platform/codex-binary';
import { normalizeSessionPreview } from './preview';

import { CodexThreadReader } from '../../packages/codex-core/src/thread-client';

export type CodexThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'unknown';

export interface CodexThreadHistoryEntry {
  threadId: string;
  sessionId?: string;
  preview: string;
  cwd: string;
  createdAtMs: number;
  updatedAtMs: number;
  source: string;
  name?: string;
}

export interface ListCodexThreadHistoryOptions {
  binary: string;
  cwd?: string;
  limit: number;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  timeoutMs?: number;
  sourceKinds?: readonly CodexThreadSourceKind[];
  useStateDbOnly?: boolean;
}

export interface SetCodexThreadNameOptions {
  binary: string;
  threadId: string;
  name: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  timeoutMs?: number;
  /** Shared app-server endpoint. `unix://` uses Codex's default control socket. */
  remote?: string;
}

export type ArchiveCodexThreadOptions = Omit<SetCodexThreadNameOptions, 'name'>;

export type CodexHistoryErrorCode =
  | 'spawn-failed'
  | 'timeout'
  | 'app-server-error'
  | 'malformed-response';

export class CodexHistoryError extends Error {
  readonly code: CodexHistoryErrorCode;

  constructor(code: CodexHistoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexHistoryError';
    this.code = code;
  }
}

const DEFAULT_HISTORY_TIMEOUT_MS = 5000;
const DEFAULT_SOURCE_KINDS: readonly CodexThreadSourceKind[] = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'unknown',
];

export async function listCodexThreadHistory(
  options: ListCodexThreadHistoryOptions,
): Promise<CodexThreadHistoryEntry[]> {
  const client = createHistoryClient(options);
  const entries: CodexThreadHistoryEntry[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  try {
    while (entries.length < options.limit) {
      const response = await client.rpc('thread/list', listRequest(options, 0, cursor, options.limit - entries.length).params);
      const parsed = parseThreadListResponse(response);
      if (!parsed.ok) throw parsed.error;
      entries.push(...parsed.entries.slice(0, options.limit - entries.length));
      if (!parsed.nextCursor || cursors.has(parsed.nextCursor)) break;
      cursor = parsed.nextCursor;
      cursors.add(cursor);
    }
    return entries;
  } catch (error) { throw historyError(error); }
  finally { await client.stop(); }
}

export async function setCodexThreadName(options: SetCodexThreadNameOptions): Promise<void> {
  await mutateCodexThread(
    options,
    'thread/name/set',
    { threadId: options.threadId, name: options.name },
  );
}

export async function archiveCodexThread(options: ArchiveCodexThreadOptions): Promise<void> {
  if (options.remote) {
    await archiveCodexThreadThroughRemote(options);
    return;
  }
  await mutateCodexThread(
    options,
    'thread/archive',
    { threadId: options.threadId },
  );
}

async function archiveCodexThreadThroughRemote(
  options: ArchiveCodexThreadOptions,
): Promise<void> {
  const child = spawnProcess(
    options.binary,
    ['archive', '--remote', options.remote!, options.threadId],
    {
      env: codexProcessEnv(options),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: CodexHistoryError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new CodexHistoryError('timeout', `codex thread archive timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.once('error', (err) => {
      finish(new CodexHistoryError('spawn-failed', errorMessage(err)));
    });
    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = Buffer.concat([...stderrChunks, ...stdoutChunks]).toString('utf8').trim();
      finish(
        new CodexHistoryError(
          'app-server-error',
          detail || `codex archive exited with ${code ?? signal ?? 'unknown status'}`,
        ),
      );
    });
  });
}

async function mutateCodexThread(
  options: ArchiveCodexThreadOptions,
  method: 'thread/name/set' | 'thread/archive',
  params: Record<string, unknown>,
): Promise<void> {
  const client = createHistoryClient(options);
  try { await client.rpc(method, params); }
  catch (error) { throw historyError(error); }
  finally { await client.stop(); }
}

function createHistoryClient(options: ListCodexThreadHistoryOptions | ArchiveCodexThreadOptions): CodexThreadReader {
  const remote = 'remote' in options ? options.remote : undefined;
  return new CodexThreadReader({
    binary: options.binary, profileStateDir: options.profileStateDir,
    codexHome: options.codexHome, inheritCodexHome: options.inheritCodexHome !== false,
    timeoutMs: options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS,
    sharedServer: Boolean(remote), remote, passive: true,
  });
}

function historyError(error: unknown): CodexHistoryError {
  if (error instanceof CodexHistoryError) return error;
  const message = errorMessage(error);
  const code: CodexHistoryErrorCode = /timed out/i.test(message) ? 'timeout'
    : /spawn|ENOENT|exited/i.test(message) ? 'spawn-failed' : 'app-server-error';
  return new CodexHistoryError(code, message, { cause: error });
}

function codexProcessEnv(options: {
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
}): NodeJS.ProcessEnv {
  const envOverrides: NodeJS.ProcessEnv = {};
  if (options.codexHome) {
    envOverrides.CODEX_HOME = options.codexHome;
  } else if (options.inheritCodexHome === false) {
    envOverrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  }
  return mergeProcessEnv(process.env, envOverrides);
}

function listRequest(
  options: ListCodexThreadHistoryOptions,
  id: number,
  cursor?: string,
  remaining = options.limit,
) {
  return {
    method: 'thread/list',
    id,
    params: {
      limit: Math.min(100, remaining),
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(cursor ? { cursor } : {}),
      useStateDbOnly: options.useStateDbOnly ?? true,
      sourceKinds: [...(options.sourceKinds ?? DEFAULT_SOURCE_KINDS)],
    },
  };
}

function parseThreadListResponse(
  input: unknown,
):
  | { ok: true; entries: CodexThreadHistoryEntry[]; nextCursor?: string }
  | { ok: false; error: CodexHistoryError } {
  const raw = recordValue(input);
  if (!raw || !Array.isArray(raw.data)) {
    return {
      ok: false,
      error: new CodexHistoryError('malformed-response', 'codex app-server returned malformed thread/list response'),
    };
  }
  return {
    ok: true,
    entries: raw.data.map(normalizeThread).filter((entry): entry is CodexThreadHistoryEntry => Boolean(entry)),
    ...(stringValue(raw.nextCursor) ? { nextCursor: stringValue(raw.nextCursor) } : {}),
  };
}

function normalizeThread(input: unknown): CodexThreadHistoryEntry | undefined {
  const raw = recordValue(input);
  if (!raw) return undefined;
  const threadId = stringValue(raw.id);
  const cwd = stringValue(raw.cwd);
  if (!threadId || !cwd) return undefined;
  const createdAt = numberValue(raw.createdAt);
  const updatedAt = numberValue(raw.updatedAt);
  return {
    threadId,
    ...(stringValue(raw.sessionId) ? { sessionId: stringValue(raw.sessionId) } : {}),
    preview: normalizeSessionPreview(stringValue(raw.preview) ?? '') || '(空会话)',
    cwd,
    createdAtMs: Math.round((createdAt ?? 0) * 1000),
    updatedAtMs: Math.round((updatedAt ?? 0) * 1000),
    source: sourceValue(raw.source),
    ...(stringValue(raw.name) ? { name: stringValue(raw.name) } : {}),
  };
}

function sourceValue(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') return JSON.stringify(input);
  return 'unknown';
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
