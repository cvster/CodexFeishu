/**
 * Web-only activity cache. Snapshot normalization, durable terminal verification
 * and observer reconnect/shutdown semantics are owned by the shared Codex core.
 */
import { runCodexCliThreadTurn } from './codex-cli-message-relay.mjs';
import { createCodexAppServerClient } from './codex-app-server-client.mjs';
import { isCodexSnapshotActive } from './codex-core/index.js';

const statusCache = new Map();
const pending = new Map();
let statusClient;

async function inferCodexSessionActive(sessionId) {
  if (!sessionId) return false;
  const cached = statusCache.get(sessionId);
  if (cached && Date.now() - cached.checkedAt < 1500) return cached.isActive;
  if (pending.has(sessionId)) return pending.get(sessionId);
  const request = (async () => {
    try {
      statusClient ??= createCodexAppServerClient();
      const snapshot = await statusClient.readReconciledThread(sessionId);
      const isActive = isCodexSnapshotActive(snapshot);
      statusCache.set(sessionId, { isActive, checkedAt: Date.now() });
      return isActive;
    } catch {
      // A transient observer outage isn't evidence the task has stopped.
      return cached?.isActive ?? false;
    } finally { pending.delete(sessionId); }
  })();
  pending.set(sessionId, request);
  return request;
}

export async function shutdownCodexObservers() {
  await statusClient?.close();
  await Promise.allSettled([...pending.values()]);
  statusClient = undefined;
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
