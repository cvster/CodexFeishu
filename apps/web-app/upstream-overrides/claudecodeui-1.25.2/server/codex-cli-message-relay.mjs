import { createCodexAppServerClient } from './codex-app-server-client.mjs';
import { resolveCodexAppProjectId } from './codex-desktop-projects.mjs';
import { CodexTurnTerminalVerifier } from './codex-turn-terminal-verifier.mjs';
import { buildNativeQueueArgs, createPersistedCodexThread, isInterruptedTurnStatus,
  isProvisionalInterruptedTurn, normalizeCodexThreadSnapshot, resolveSharedCodexEndpoint,
  spawnCodexProcess } from './codex-core/index.js';

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
const QUEUED_TURN_POLL_INTERVAL_MS = 750;
const INTERRUPTED_SETTLE_MS = 3_000;
const relayQueues = new Map();

function normalizeRequiredText(value, fieldName) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`Missing ${fieldName} for Codex CLI message delivery.`);
  return normalized;
}

function validateMessage(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Missing message for Codex CLI message delivery.');
  }
  return value;
}

function isProjectlessPath(value) {
  return typeof value === 'string' && value.startsWith('codex://');
}

export function buildCodexQueueArgs({
  sessionId,
  message,
  remote,
}) {
  return buildNativeQueueArgs({ threadId: normalizeRequiredText(sessionId, 'sessionId'),
    prompt: validateMessage(message), remote });
}

export async function queueCodexCliThreadMessage(payload, dependencies = {}) {
  const sessionId = normalizeRequiredText(payload.sessionId, 'sessionId');
  const projectPath = normalizeRequiredText(payload.projectPath, 'projectPath');
  const cwd = isProjectlessPath(projectPath) ? process.cwd() : projectPath;
  const cliPath = dependencies.cliPath || process.env.MOBILE_CODEX_CLI;
  if (!cliPath || typeof cliPath !== 'string') {
    throw new Error('MOBILE_CODEX_CLI is required for Codex queue delivery.');
  }

  const spawnImpl = dependencies.spawnImpl || spawnCodexProcess;
  const timeoutMs = Number(process.env.MOBILE_CODEX_QUEUE_TIMEOUT_MS || DEFAULT_QUEUE_TIMEOUT_MS);
  const createClient = dependencies.createClient || createCodexAppServerClient;
  const client = createClient({ cwd });

  try {
    await client.request('initialize', {
      clientInfo: { name: 'mobile-codex-helper', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');

    // The app-server client is read-only. Existing Desktop-owned threads must
    // be queued through the shared daemon instead of being resumed here,
    // otherwise this helper competes for the thread writer lease.
    const baseline = await client.request('thread/read', {
      threadId: sessionId,
      includeTurns: true,
    });
    const knownTurnIds = new Set(
      (Array.isArray(baseline?.thread?.turns) ? baseline.thread.turns : [])
        .map((turn) => turn?.id)
        .filter(Boolean),
    );

    const remote = process.env.MOBILE_CODEX_QUEUE_REMOTE || process.env.CODEX_QUEUE_REMOTE;
    // Apply execution settings only through the actual shared writer, never
    // through an embedded observer's resume or queue configuration overrides.
    if (payload.model || payload.modelReasoningEffort) {
      const endpoint = await (dependencies.resolveEndpoint || resolveSharedCodexEndpoint)({ remote });
      if (endpoint) {
        const writer = createClient({ cwd, cliPath, sharedServer: true, remote: endpoint });
        try {
          await writer.updateThreadSettings(sessionId, {
            model: payload.model, reasoningEffort: payload.modelReasoningEffort,
          });
        } finally { await writer.close(); }
      } else (payload.onWarning || console.warn)('No public shared writer: queued input uses the writer’s current model and effort.');
    }
    const child = spawnImpl(cliPath, buildCodexQueueArgs({
      sessionId,
      message: payload.message,
      remote,
    }), {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));

    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(reject, new Error(`codex queue timed out after ${timeoutMs}ms`));
      }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_QUEUE_TIMEOUT_MS);
      child.once('error', (error) => finish(reject, error));
      child.once('exit', (code, signal) => finish(resolve, { code, signal }));
    });

    const output = Buffer.concat(stdout).toString('utf8').trim();
    const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
    if (result.code !== 0) {
      const detail = errorOutput || output;
      throw new Error(
        `codex queue exited with ${result.code ?? result.signal ?? 'unknown status'}${detail ? `: ${detail}` : ''}`,
      );
    }

    const queueMessageId = /Queued message\s+([^\s.]+)\s+for thread/i.exec(output)?.[1];
    await waitForQueuedTurn(client, {
      sessionId,
      message: payload.message,
      knownTurnIds,
      timeoutMs: dependencies.turnTimeoutMs ?? Number(process.env.MOBILE_CODEX_TURN_TIMEOUT_MS || DEFAULT_TURN_TIMEOUT_MS),
      pollIntervalMs: dependencies.pollIntervalMs ?? QUEUED_TURN_POLL_INTERVAL_MS,
      interruptedSettleMs: dependencies.interruptedSettleMs ?? INTERRUPTED_SETTLE_MS,
      terminalVerifier: dependencies.terminalVerifier ?? new CodexTurnTerminalVerifier(),
    });
    return { skipped: false, sessionId, ...(queueMessageId ? { queueMessageId } : {}) };
  } finally {
    await client.close();
  }
}

async function waitForQueuedTurn(
  client,
  {
    sessionId,
    message,
    knownTurnIds,
    timeoutMs,
    pollIntervalMs,
    interruptedSettleMs,
    terminalVerifier,
  },
) {
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TURN_TIMEOUT_MS;
  const deadline = Date.now() + safeTimeoutMs;
  let selectedTurnId = null;
  let interruptedObservedAt = null;
  let persistedTerminalSeen = null;

  while (Date.now() < deadline) {
    const snapshot = await client.request('thread/read', {
      threadId: sessionId,
      includeTurns: true,
    });
    const normalized = normalizeCodexThreadSnapshot({ ...snapshot.thread, id: snapshot.thread?.id || sessionId });
    const turns = normalized?.turns ?? [];
    const selected = selectedTurnId
      ? turns.find((turn) => turn?.id === selectedTurnId)
      : turns.find((turn) => !knownTurnIds.has(turn?.id) && turnContainsMessage(turn, message));
    if (selected) {
      selectedTurnId ||= selected.id;
      if (selected.status === 'completed') return;
      if (isInterruptedTurnStatus(selected.status)) {
        const durableTerminal = await terminalVerifier.terminalFor(
          normalized?.rolloutPath,
          selected.id,
        );
        if (durableTerminal) {
          const terminalKey = `${selected.id}:${durableTerminal}`;
          if (persistedTerminalSeen !== terminalKey) {
            // The rollout can advance just before thread/read exposes the last
            // assistant item. Take one more snapshot before completing.
            persistedTerminalSeen = terminalKey;
          } else if (durableTerminal === 'completed') {
            return;
          } else {
            throw new Error(selected.error?.message || 'Codex queued turn interrupted');
          }
        } else {
          persistedTerminalSeen = null;
          interruptedObservedAt ??= Date.now();
          const stillSettling = Date.now() - interruptedObservedAt < interruptedSettleMs;
          // A rollout path without a durable terminal event means the
          // read-only app-server is projecting another writer's live turn.
          // Older/fake servers without a path retain the short settle window.
          if (!normalized?.rolloutPath && !stillSettling && !isProvisionalInterruptedTurn(normalized, selected)) {
            throw new Error(selected.error?.message || 'Codex queued turn interrupted');
          }
        }
      } else if (selected.status === 'failed') {
        throw new Error(selected.error?.message || `Codex queued turn ${selected.status}`);
      } else {
        interruptedObservedAt = null;
        persistedTerminalSeen = null;
      }
    }

    // An observer never resumes a dormant/busy thread as a queue fallback.
    // Only the external writer may consume queued work.
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Codex queued turn timed out after ${safeTimeoutMs}ms`);
}

function turnContainsMessage(turn, message) {
  return Array.isArray(turn?.items) && turn.items.some((item) => (
    item?.type === 'userMessage' &&
    Array.isArray(item.content) &&
    item.content.some((content) => content?.type === 'text' && content.text === message)
  ));
}

export async function runCodexCliThreadTurn(payload, dependencies = {}) {
  const message = validateMessage(payload.message);
  const projectPath = normalizeRequiredText(payload.projectPath, 'projectPath');
  const existingSessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (existingSessionId) {
    const queueThreadMessage = dependencies.queueThreadMessage || queueCodexCliThreadMessage;
    return queueThreadMessage({ ...payload, sessionId: existingSessionId, message }, dependencies);
  }

  const projectless = isProjectlessPath(projectPath);
  const cwd = projectless ? process.cwd() : projectPath;
  const resolveProjectId = dependencies.resolveProjectId || resolveCodexAppProjectId;
  const projectId = projectless ? null : await resolveProjectId(projectPath);
  const createClient = dependencies.createClient || createCodexAppServerClient;
  const client = createClient({ cwd });
  let sessionId;

  try {
    await client.request('initialize', {
      clientInfo: { name: 'mobile-codex-helper', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');

    sessionId = await createPersistedCodexThread(client, {
      cwd,
      ...(projectId ? { projectId } : {}),
      ...(payload.model ? { model: payload.model } : {}),
      sandbox: 'danger-full-access',
      reasoningEffort: payload.modelReasoningEffort,
      threadSource: 'user',
    });
    payload.onSessionCreated?.(sessionId);
  } finally {
    await client.close();
  }
  // The creator is closed before delivery. Restarting this web process now
  // only loses an observer, never the writer executing the first task.
  const queueThreadMessage = dependencies.queueThreadMessage || queueCodexCliThreadMessage;
  return queueThreadMessage({ ...payload, sessionId, message }, dependencies);
}

export function enqueueCodexCliMessage(payload, dependencies = {}) {
  const queueKey = payload.sessionId || `${payload.projectPath}:new-session`;
  const previous = relayQueues.get(queueKey) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => {
      const runThreadTurn = dependencies.runThreadTurn || runCodexCliThreadTurn;
      return runThreadTurn(payload, dependencies);
    })
    .catch((error) => ({ skipped: true, reason: 'relay-error', error: error.message }))
    .finally(() => {
      if (relayQueues.get(queueKey) === next) relayQueues.delete(queueKey);
    });
  relayQueues.set(queueKey, next);
  return next;
}
