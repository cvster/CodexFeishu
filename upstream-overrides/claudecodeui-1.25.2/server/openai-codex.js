/**
 * Codex session activity helpers.
 *
 * Message execution is handled by codex-cli-message-relay.mjs through the Codex
 * CLI app-server protocol. This module only inspects rollout state and preserves
 * the small session-status API consumed by the upstream server.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { runCodexCliThreadTurn } from './codex-cli-message-relay.mjs';

const codexSessionFileCache = new Map();
const codexSessionStatusCache = new Map();
const CODEX_STATUS_CACHE_TTL_MS = 1500;
const CODEX_STATUS_TAIL_BYTES = 256 * 1024;
const CODEX_STATUS_TAIL_LINES = 300;
const CODEX_TERMINAL_EVENT_TYPES = new Set(['task_complete', 'turn_complete', 'session_aborted']);
const CODEX_ACTIVE_EVENT_TYPES = new Set([
  'agent_message',
  'exec_command_begin',
  'exec_command_end',
  'patch_apply_begin',
  'patch_apply_end',
  'error',
]);
const CODEX_ACTIVE_RESPONSE_TYPES = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
]);

function isVisibleCodexUserMessagePayload(payload) {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}

function classifyCodexSessionTimelineEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  if (entry.type === 'event_msg') {
    if (isVisibleCodexUserMessagePayload(entry.payload)) {
      return 'active';
    }

    const eventType = entry.payload?.type;
    if (CODEX_TERMINAL_EVENT_TYPES.has(eventType)) {
      return 'terminal';
    }

    if (CODEX_ACTIVE_EVENT_TYPES.has(eventType)) {
      return 'active';
    }

    return null;
  }

  if (entry.type === 'response_item') {
    const responseType = entry.payload?.type;
    if (CODEX_ACTIVE_RESPONSE_TYPES.has(responseType)) {
      return 'active';
    }
  }

  return null;
}

async function readJsonlTailLines(
  filePath,
  maxBytes = CODEX_STATUS_TAIL_BYTES,
  maxLines = CODEX_STATUS_TAIL_LINES,
) {
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

async function resolveCodexSessionFile(sessionId) {
  if (!sessionId) {
    return null;
  }

  const cachedPath = codexSessionFileCache.get(sessionId);
  if (cachedPath) {
    try {
      await fs.access(cachedPath);
      return cachedPath;
    } catch {
      codexSessionFileCache.delete(sessionId);
    }
  }

  const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
  const matchedPath = await findCodexSessionRolloutFileInDir(sessionsRoot, sessionId);
  if (matchedPath) {
    codexSessionFileCache.set(sessionId, matchedPath);
  }

  return matchedPath;
}

async function inferCodexSessionActive(sessionId) {
  const filePath = await resolveCodexSessionFile(sessionId);
  if (!filePath) {
    return false;
  }

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return false;
  }

  const cachedStatus = codexSessionStatusCache.get(sessionId);
  if (
    cachedStatus &&
    cachedStatus.mtimeMs === stats.mtimeMs &&
    Date.now() - cachedStatus.checkedAt < CODEX_STATUS_CACHE_TTL_MS
  ) {
    return cachedStatus.isActive;
  }

  const lines = await readJsonlTailLines(filePath);
  let latestMeaningfulState = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }

    const entryState = classifyCodexSessionTimelineEntry(entry);
    if (entryState) {
      latestMeaningfulState = entryState;
      break;
    }
  }

  const isActive = latestMeaningfulState === 'active';
  codexSessionStatusCache.set(sessionId, {
    checkedAt: Date.now(),
    mtimeMs: stats.mtimeMs,
    isActive,
  });

  return isActive;
}

// Compatibility entry point for the upstream Agent API. It uses the same CLI
// app-server transport as web chat and therefore does not create a second kind
// of Codex session.
export async function queryCodex(command, options = {}, writer) {
  const projectPath = options.cwd || options.projectPath || process.cwd();
  let createdSessionId = null;
  const result = await runCodexCliThreadTurn({
    message: command,
    projectPath,
    sessionId: options.sessionId || null,
    model: options.model,
    modelReasoningEffort: options.modelReasoningEffort,
    onSessionCreated: (sessionId) => {
      createdSessionId = sessionId;
      writer?.send?.({ type: 'session-created', sessionId, provider: 'codex' });
    },
  });

  const sessionId = result.sessionId || createdSessionId || options.sessionId || null;
  writer?.send?.({ type: 'codex-complete', sessionId, actualSessionId: sessionId });
  return result;
}

export function abortCodexSession() {
  return false;
}

export async function isCodexSessionActive(sessionId) {
  return inferCodexSessionActive(sessionId);
}

export function getActiveCodexSessions() {
  return [];
}

export function reconnectCodexSessionWriter() {
  return false;
}
