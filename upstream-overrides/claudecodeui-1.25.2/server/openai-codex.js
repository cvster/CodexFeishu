/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the pattern used in claude-sdk.js for consistency.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 * - reconnectCodexSessionWriter(sessionId, ws) - Rebind an active session to a reconnected WebSocket
 */

import { Codex } from '@openai/codex-sdk';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { enqueueCodexDesktopSync } from './codex-desktop-sync.js';
import { sessionOriginsDb } from './database/db.js';

// Track active sessions
const activeCodexSessions = new Map();
const desktopCodexSessionFileCache = new Map();
const desktopCodexSessionStatusCache = new Map();
const CODEX_ONLY_HARDENED_MODE = process.env.CODEX_ONLY_HARDENED_MODE !== 'false';
const HARDENED_BACKEND_PERMISSION_MODE = process.env.MOBILE_CODEX_BACKEND_PERMISSION_MODE || 'bypassPermissions';
const DESKTOP_CODEX_STATUS_CACHE_TTL_MS = 1500;
const DESKTOP_CODEX_STATUS_TAIL_BYTES = 256 * 1024;
const DESKTOP_CODEX_STATUS_TAIL_LINES = 300;
const DESKTOP_CODEX_TERMINAL_EVENT_TYPES = new Set(['task_complete', 'turn_complete', 'session_aborted']);
const DESKTOP_CODEX_ACTIVE_EVENT_TYPES = new Set([
  'agent_message',
  'exec_command_begin',
  'exec_command_end',
  'patch_apply_begin',
  'patch_apply_end',
  'error',
]);
const DESKTOP_CODEX_ACTIVE_RESPONSE_TYPES = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
]);
const CODEX_MODEL_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

const NON_ASCII_PATH_PATTERN = /[^\u0000-\u007F]/;

function containsNonAscii(value) {
  return typeof value === 'string' && NON_ASCII_PATH_PATTERN.test(value);
}

async function ensureAsciiWorkingDirectory(projectPath) {
  if (process.platform !== 'win32' || !containsNonAscii(projectPath)) {
    return projectPath;
  }

  const resolvedProjectPath = path.resolve(projectPath);
  const projectDriveRoot = path.parse(resolvedProjectPath).root || 'C:\\';
  const aliasRoot = path.join(projectDriveRoot, 'codex_project_aliases');
  const aliasName = crypto.createHash('sha1').update(resolvedProjectPath.toLowerCase()).digest('hex');
  const aliasPath = path.join(aliasRoot, aliasName);

  await fs.mkdir(aliasRoot, { recursive: true });

  try {
    const aliasStats = await fs.lstat(aliasPath);
    if (aliasStats.isDirectory() || aliasStats.isSymbolicLink()) {
      return aliasPath;
    }

    if (!aliasStats.isSymbolicLink() && !aliasStats.isDirectory()) {
      await fs.rm(aliasPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.symlink(resolvedProjectPath, aliasPath, 'junction');
  return aliasPath;
}

function isVisibleCodexUserMessagePayload(payload) {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}

function classifyDesktopCodexSessionTimelineEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  if (entry.type === 'event_msg') {
    if (isVisibleCodexUserMessagePayload(entry.payload)) {
      return 'active';
    }

    const eventType = entry.payload?.type;
    if (DESKTOP_CODEX_TERMINAL_EVENT_TYPES.has(eventType)) {
      return 'terminal';
    }

    if (DESKTOP_CODEX_ACTIVE_EVENT_TYPES.has(eventType)) {
      return 'active';
    }

    return null;
  }

  if (entry.type === 'response_item') {
    const responseType = entry.payload?.type;
    if (DESKTOP_CODEX_ACTIVE_RESPONSE_TYPES.has(responseType)) {
      return 'active';
    }
  }

  return null;
}

async function readJsonlTailLines(filePath, maxBytes = DESKTOP_CODEX_STATUS_TAIL_BYTES, maxLines = DESKTOP_CODEX_STATUS_TAIL_LINES) {
  const fileHandle = await fs.open(filePath, 'r');

  try {
    const stats = await fileHandle.stat();
    const bytesToRead = Math.min(stats.size, maxBytes);
    const start = Math.max(0, stats.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);

    await fileHandle.read(buffer, 0, bytesToRead, start);

    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewlineIndex = text.indexOf('\n');
      text = firstNewlineIndex >= 0 ? text.slice(firstNewlineIndex + 1) : '';
    }

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.slice(-maxLines);
  } finally {
    await fileHandle.close();
  }
}

async function findCodexSessionRolloutFileInDir(dirPath, sessionId) {
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const nestedMatch = await findCodexSessionRolloutFileInDir(fullPath, sessionId);
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) {
      return fullPath;
    }
  }

  return null;
}

async function resolveDesktopCodexSessionFile(sessionId) {
  if (!sessionId) {
    return null;
  }

  const cachedPath = desktopCodexSessionFileCache.get(sessionId);
  if (cachedPath) {
    try {
      await fs.access(cachedPath);
      return cachedPath;
    } catch {
      desktopCodexSessionFileCache.delete(sessionId);
    }
  }

  const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
  const matchedPath = await findCodexSessionRolloutFileInDir(sessionsRoot, sessionId);
  if (matchedPath) {
    desktopCodexSessionFileCache.set(sessionId, matchedPath);
  }

  return matchedPath;
}

async function inferDesktopCodexSessionActive(sessionId) {
  const filePath = await resolveDesktopCodexSessionFile(sessionId);
  if (!filePath) {
    return false;
  }

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return false;
  }

  const cachedStatus = desktopCodexSessionStatusCache.get(sessionId);
  if (
    cachedStatus &&
    cachedStatus.mtimeMs === stats.mtimeMs &&
    Date.now() - cachedStatus.checkedAt < DESKTOP_CODEX_STATUS_CACHE_TTL_MS
  ) {
    return cachedStatus.isActive;
  }

  const lines = await readJsonlTailLines(filePath);
  let latestMeaningfulState = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const entryState = classifyDesktopCodexSessionTimelineEntry(entry);
    if (entryState) {
      latestMeaningfulState = entryState;
      break;
    }
  }

  const isActive = latestMeaningfulState === 'active';
  desktopCodexSessionStatusCache.set(sessionId, {
    checkedAt: Date.now(),
    mtimeMs: stats.mtimeMs,
    isActive,
  });

  return isActive;
}

function normalizeComparablePath(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  try {
    return path.resolve(value.replace(/^\\\\\?\\/, '')).toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

async function collectCodexJsonlFiles(dirPath, files = []) {
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await collectCodexJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }

  return files;
}

async function readCodexSessionMeta(filePath) {
  let fileStream;
  let rl;
  try {
    fileStream = fsSync.createReadStream(filePath);
    rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line);
        if (entry.type === 'session_meta' && entry.payload?.id) {
          return {
            id: entry.payload.id,
            cwd: entry.payload.cwd || '',
            source: entry.payload.source || '',
            timestamp: entry.payload.timestamp || entry.timestamp || null,
          };
        }
      } catch {
        // Skip malformed JSONL entries.
      }
    }
  } catch {
    return null;
  } finally {
    rl?.close();
    fileStream?.destroy();
  }

  return null;
}

async function resolveCodexSdkRolloutSessionId(projectPath, startedAtMs) {
  const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
  const comparableProjectPath = normalizeComparablePath(projectPath);
  const files = await collectCodexJsonlFiles(sessionsRoot);
  const candidates = [];

  for (const filePath of files) {
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch {
      continue;
    }

    if (stats.mtimeMs < startedAtMs - 5 * 60 * 1000) {
      continue;
    }

    const meta = await readCodexSessionMeta(filePath);
    if (!meta?.id) {
      continue;
    }

    const metaTimestampMs = Date.parse(meta.timestamp || '');
    if (Number.isFinite(metaTimestampMs) && metaTimestampMs < startedAtMs - 60 * 1000) {
      continue;
    }

    if (comparableProjectPath && normalizeComparablePath(meta.cwd) !== comparableProjectPath) {
      continue;
    }

    candidates.push({
      id: meta.id,
      source: meta.source,
      timestampMs: Number.isFinite(metaTimestampMs) ? metaTimestampMs : stats.mtimeMs,
    });
  }

  candidates.sort((left, right) => right.timestampMs - left.timestampMs);
  return candidates.find((candidate) => candidate.source === 'exec')?.id || candidates[0]?.id || null;
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event) {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // Transform based on item type
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode) {
  switch (permissionMode) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: CODEX_ONLY_HARDENED_MODE ? 'never' : 'untrusted'
      };
  }
}

function getEffectivePermissionMode(permissionMode, sessionOrigin) {
  if (CODEX_ONLY_HARDENED_MODE && sessionOrigin !== 'app') {
    return HARDENED_BACKEND_PERMISSION_MODE;
  }

  return permissionMode || 'default';
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, modelReasoningEffort, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export async function queryCodex(command, options = {}, ws) {
  const {
    sessionId,
    cwd,
    projectPath,
    model,
    modelReasoningEffort,
    permissionMode = 'default',
    desktopSync = null,
    sessionOrigin = 'backend',
    syncToDesktop = true
  } = options;

  const requestedWorkingDirectory = cwd || projectPath || process.cwd();
  const displayProjectPath = path.resolve(requestedWorkingDirectory);
  const workingDirectory = await ensureAsciiWorkingDirectory(requestedWorkingDirectory);
  if (workingDirectory !== requestedWorkingDirectory) {
    console.log('[Codex] Using ASCII working directory alias:', workingDirectory, 'for', requestedWorkingDirectory);
  }
  const effectivePermissionMode = getEffectivePermissionMode(permissionMode, sessionOrigin);
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(effectivePermissionMode);
  const normalizedModelReasoningEffort =
    typeof modelReasoningEffort === 'string' && CODEX_MODEL_REASONING_EFFORTS.has(modelReasoningEffort)
      ? modelReasoningEffort
      : undefined;

  let codex;
  let thread;
  let currentSessionId = sessionId;
  let actualSessionId = sessionId || null;
  const turnStartedAtMs = Date.now();
  const abortController = new AbortController();

  try {
    // Initialize Codex SDK
    codex = new Codex();

    // Thread options with sandbox and approval settings
    const threadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model,
      ...(normalizedModelReasoningEffort ? { modelReasoningEffort: normalizedModelReasoningEffort } : {})
    };

    // Start or resume thread
    if (sessionId) {
      thread = codex.resumeThread(sessionId, threadOptions);
    } else {
      thread = codex.startThread(threadOptions);
    }

    // Get the thread ID
    currentSessionId = thread.id || sessionId || `codex-${Date.now()}`;
    sessionOriginsDb.setOrigin(currentSessionId, 'codex', sessionOrigin === 'app' ? 'app' : 'backend');

    // Track the session
    activeCodexSessions.set(currentSessionId, {
      thread,
      codex,
      status: 'running',
      abortController,
      startedAt: new Date().toISOString(),
      writer: ws,
      projectPath: displayProjectPath,
      desktopSync
    });

    if (ws.setSessionId && typeof ws.setSessionId === 'function') {
      ws.setSessionId(currentSessionId);
    }

    // Send session created event
    sendMessage(ws, {
      type: 'session-created',
      sessionId: currentSessionId,
      provider: 'codex'
    });

    if (syncToDesktop) {
      void enqueueCodexDesktopSync({
        sessionId: currentSessionId,
        projectPath: displayProjectPath,
        sessionTitleHint: null,
        allowLatestFallback: !sessionId,
        reason: 'turn-start',
        sourceContext: desktopSync
      });
    }

    // Execute with streaming
    const streamedTurn = await thread.runStreamed(command, {
      signal: abortController.signal
    });

    for await (const event of streamedTurn.events) {
      // Check if session was aborted
      const session = activeCodexSessions.get(currentSessionId);
      if (!session || session.status === 'aborted') {
        break;
      }

      if (event.type === 'item.started' || event.type === 'item.updated') {
        continue;
      }

      const transformed = transformCodexEvent(event);

      sendMessage(ws, {
        type: 'codex-response',
        data: transformed,
        sessionId: currentSessionId
      });

      // Extract and send token usage if available (normalized to match Claude format)
      if (event.type === 'turn.completed' && event.usage) {
        const totalTokens = (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0);
        sendMessage(ws, {
          type: 'token-budget',
          data: {
            used: totalTokens,
            total: 200000 // Default context window for Codex models
          },
          sessionId: currentSessionId
        });
      }
    }

    actualSessionId = thread.id || await resolveCodexSdkRolloutSessionId(displayProjectPath, turnStartedAtMs);
    if (actualSessionId && actualSessionId !== currentSessionId) {
      sessionOriginsDb.setOrigin(actualSessionId, 'codex', sessionOrigin === 'app' ? 'app' : 'backend');
    }

    // Send completion event
    sendMessage(ws, {
      type: 'codex-complete',
      sessionId: currentSessionId,
      actualSessionId: actualSessionId || thread.id
    });

    if (syncToDesktop) {
      void enqueueCodexDesktopSync({
        sessionId: currentSessionId,
        projectPath: displayProjectPath,
        sessionTitleHint: null,
        allowLatestFallback: true,
        reason: 'turn-complete',
        sourceContext: desktopSync
      });
    }

  } catch (error) {
    const session = currentSessionId ? activeCodexSessions.get(currentSessionId) : null;
    const wasAborted =
      session?.status === 'aborted' ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);
      sendMessage(ws, {
        type: 'codex-error',
        error: error.message,
        sessionId: currentSessionId
      });
    }

  } finally {
    // Update session status
    if (currentSessionId) {
      const session = activeCodexSessions.get(currentSessionId);
      if (session) {
        session.status = session.status === 'aborted' ? 'aborted' : 'completed';
      }
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export function abortCodexSession(sessionId) {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  try {
    session.abortController?.abort();
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/**
 * Check if a session is active
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} - Whether session is active
 */
export async function isCodexSessionActive(sessionId) {
  const session = activeCodexSessions.get(sessionId);
  if (session?.status === 'running') {
    return true;
  }

  return inferDesktopCodexSessionActive(sessionId);
}

/**
 * Get all active sessions
 * @returns {Array} - Array of active session info
 */
export function getActiveCodexSessions() {
  const sessions = [];

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status === 'running') {
      sessions.push({
        id,
        status: session.status,
        startedAt: session.startedAt
      });
    }
  }

  return sessions;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects while Codex is still streaming.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
export function reconnectCodexSessionWriter(sessionId, newRawWs) {
  const session = activeCodexSessions.get(sessionId);
  if (!session?.writer?.updateWebSocket) {
    return false;
  }

  session.writer.updateWebSocket(newRawWs);
  console.log(`[Codex] Writer swapped for session ${sessionId}`);
  return true;
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes
