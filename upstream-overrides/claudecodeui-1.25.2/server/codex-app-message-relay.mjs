import { spawn } from 'node:child_process';
const DEFAULT_RELAY_TIMEOUT_MS = 120_000;
const MAX_PROCESS_OUTPUT_LENGTH = 64 * 1024;

const relayQueues = new Map();

function normalizeRequiredText(value, fieldName) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`Missing ${fieldName} for Codex App message relay.`);
  }
  return normalized;
}

function validateMessage(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Missing message for Codex App message relay.');
  }
  return value;
}

export function buildCodexAppMessageRelayArgs({ sessionId, projectPath, message }) {
  return [
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
    '-C',
    normalizeRequiredText(projectPath, 'projectPath'),
  ];
}

function appendProcessOutput(current, chunk) {
  const combined = `${current}${chunk.toString('utf8')}`;
  return combined.length > MAX_PROCESS_OUTPUT_LENGTH
    ? combined.slice(-MAX_PROCESS_OUTPUT_LENGTH)
    : combined;
}

async function terminateProcessTree(child) {
  if (!child?.pid) {
    return;
  }
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }

  await new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', resolve);
    killer.once('exit', resolve);
  });
}

export async function runCodexAppMessageRelayCommand(args, options = {}) {
  const codexCli = normalizeRequiredText(process.env.MOBILE_CODEX_CLI, 'MOBILE_CODEX_CLI');
  const timeoutMs = Number(
    process.env.MOBILE_CODEX_QUEUE_TIMEOUT_MS ||
      process.env.MOBILE_CODEX_APP_MESSAGE_RELAY_TIMEOUT_MS ||
      DEFAULT_RELAY_TIMEOUT_MS,
  );

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const child = spawn(codexCli, args, {
    cwd: options.cwd || process.cwd(),
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    stdout = appendProcessOutput(stdout, chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr = appendProcessOutput(stderr, chunk);
  });
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    void terminateProcessTree(child);
  }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_RELAY_TIMEOUT_MS);

  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code));
    });
    if (timedOut) {
      throw new Error(`Codex App message relay timed out after ${timeoutMs}ms.`);
    }
    if (exitCode !== 0) {
      throw new Error(
        `Codex App message relay exited with code ${exitCode}: ${(stderr || stdout).trim() || '<no output>'}`,
      );
    }

    return stdout.trim();
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function enqueueCodexAppMessageRelay(payload, dependencies) {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (!sessionId) {
    return Promise.resolve({
      skipped: true,
      reason: 'session-id-missing',
      error: 'Existing Codex App session id is required for native queue delivery.',
    });
  }

  const queueKey = sessionId;
  const previous = relayQueues.get(queueKey) || Promise.resolve();

  const next = previous
    .catch(() => {})
    .then(async () => {
      const args = buildCodexAppMessageRelayArgs({
        sessionId,
        projectPath: payload.projectPath,
        message: payload.message,
      });
      const runRelayCommand =
        dependencies.runRelayCommand || runCodexAppMessageRelayCommand;
      await runRelayCommand(args, { cwd: payload.projectPath });
      return {
        skipped: false,
        sessionId,
      };
    })
    .catch((error) => ({
      skipped: true,
      reason: 'relay-error',
      error: error.message,
    }))
    .finally(() => {
      if (relayQueues.get(queueKey) === next) {
        relayQueues.delete(queueKey);
      }
    });

  relayQueues.set(queueKey, next);
  return next;
}
