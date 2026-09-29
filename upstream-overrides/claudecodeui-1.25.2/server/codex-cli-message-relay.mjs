import { spawn } from 'node:child_process';

import { createCodexAppServerClient } from './codex-app-server-client.mjs';
import { resolveCodexAppProjectId } from './codex-desktop-projects.mjs';

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
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
  cwd,
  model,
  modelReasoningEffort,
}) {
  const args = [
    'queue',
    '--thread',
    normalizeRequiredText(sessionId, 'sessionId'),
    '--message',
    validateMessage(message),
    '--sandbox',
    'danger-full-access',
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="all"',
  ];
  if (model) args.push('--model', model);
  if (modelReasoningEffort) {
    args.push('-c', `model_reasoning_effort="${modelReasoningEffort}"`);
  }
  args.push('-C', cwd);
  return args;
}

export async function queueCodexCliThreadMessage(payload, dependencies = {}) {
  const sessionId = normalizeRequiredText(payload.sessionId, 'sessionId');
  const projectPath = normalizeRequiredText(payload.projectPath, 'projectPath');
  const cwd = isProjectlessPath(projectPath) ? process.cwd() : projectPath;
  const cliPath = dependencies.cliPath || process.env.MOBILE_CODEX_CLI;
  if (!cliPath || typeof cliPath !== 'string') {
    throw new Error('MOBILE_CODEX_CLI is required for Codex queue delivery.');
  }

  const spawnImpl = dependencies.spawnImpl || spawn;
  const timeoutMs = Number(process.env.MOBILE_CODEX_QUEUE_TIMEOUT_MS || DEFAULT_QUEUE_TIMEOUT_MS);
  const child = spawnImpl(cliPath, buildCodexQueueArgs({
    sessionId,
    message: payload.message,
    cwd,
    model: payload.model,
    modelReasoningEffort: payload.modelReasoningEffort,
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
  return { skipped: false, sessionId, ...(queueMessageId ? { queueMessageId } : {}) };
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
  const turnTimeoutMs = Number(process.env.MOBILE_CODEX_TURN_TIMEOUT_MS || DEFAULT_TURN_TIMEOUT_MS);

  try {
    await client.request('initialize', {
      clientInfo: { name: 'mobile-codex-helper', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');

    const threadResult = await client.request('thread/start', {
      ...(projectless ? {} : { cwd: projectPath }),
      ...(projectId ? { projectId } : {}),
      ...(payload.model ? { model: payload.model } : {}),
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      threadSource: 'user',
    });
    const sessionId = normalizeRequiredText(threadResult?.thread?.id, 'created sessionId');

    const completion = client.waitForNotification(
      'turn/completed',
      (params) => params?.threadId === sessionId,
      Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0 ? turnTimeoutMs : DEFAULT_TURN_TIMEOUT_MS,
    );
    await client.request('turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: message, text_elements: [] }],
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.modelReasoningEffort ? { effort: payload.modelReasoningEffort } : {}),
    });
    payload.onSessionCreated?.(sessionId);
    await completion;
    return { skipped: false, sessionId };
  } finally {
    await client.close();
  }
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
