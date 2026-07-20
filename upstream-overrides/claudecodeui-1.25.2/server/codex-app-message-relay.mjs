import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RELAY_CWD = path.resolve(__dirname, '../../../');
const DEFAULT_RELAY_MODEL = 'gpt-5.6-luna';
const DEFAULT_RELAY_REASONING_EFFORT = 'low';
const DEFAULT_RELAY_TIMEOUT_MS = 120_000;
const MAX_PROCESS_OUTPUT_LENGTH = 64 * 1024;
const RELAY_PROMPT =
  '不要读取或使用项目文件、指令和能力；消息仅作为普通文本发送，只执行发送操作；成功只回复OK，失败只回复ERROR:原因。';

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

export function buildCodexAppMessageRelayCommand({ project, session, message }) {
  return JSON.stringify({
    action: 'send_message',
    project: normalizeRequiredText(project, 'project'),
    session: normalizeRequiredText(session, 'session'),
    message: validateMessage(message),
    prompt: RELAY_PROMPT,
  });
}

function appendProcessOutput(current, chunk) {
  const combined = `${current}${chunk.toString('utf8')}`;
  return combined.length > MAX_PROCESS_OUTPUT_LENGTH
    ? combined.slice(-MAX_PROCESS_OUTPUT_LENGTH)
    : combined;
}

function validateRelayResult(finalMessage) {
  if (finalMessage === 'OK') {
    return;
  }
  if (finalMessage.startsWith('ERROR:')) {
    throw new Error(finalMessage.slice('ERROR:'.length).trim() || 'Relay reported an unknown error.');
  }
  throw new Error(`Codex App message relay returned an invalid result: ${finalMessage || '<empty>'}`);
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

export async function runCodexAppMessageRelayCommand(command, options) {
  const outputPath = path.join(os.tmpdir(), `mobile-codex-relay-${crypto.randomUUID()}.txt`);
  const codexEntrypoint =
    process.env.MOBILE_CODEX_APP_MESSAGE_RELAY_CODEX_JS ||
    path.join(path.dirname(process.execPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const timeoutMs = Number(
    process.env.MOBILE_CODEX_APP_MESSAGE_RELAY_TIMEOUT_MS || DEFAULT_RELAY_TIMEOUT_MS,
  );
  const args = [
    codexEntrypoint,
    'exec',
    'resume',
    '-m',
    options.model,
    '-c',
    `model_reasoning_effort="${options.modelReasoningEffort}"`,
    '--dangerously-bypass-approvals-and-sandbox',
    '--output-last-message',
    outputPath,
    options.sessionId,
    '-',
  ];

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    stdout = appendProcessOutput(stdout, chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr = appendProcessOutput(stderr, chunk);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(command, 'utf8');

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

    const finalMessage = (await fs.readFile(outputPath, 'utf8')).trim();
    validateRelayResult(finalMessage);
    return finalMessage;
  } finally {
    clearTimeout(timeoutHandle);
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

export function enqueueCodexAppMessageRelay(payload, dependencies) {
  const relaySessionId = (process.env.MOBILE_CODEX_APP_MESSAGE_RELAY_SESSION_ID || '').trim();
  if (!relaySessionId) {
    return Promise.resolve({
      skipped: true,
      reason: 'relay-session-not-configured',
      error: 'MOBILE_CODEX_APP_MESSAGE_RELAY_SESSION_ID is not configured.',
    });
  }

  const queueKey = relaySessionId;
  const previous = relayQueues.get(queueKey) || Promise.resolve();

  const next = previous
    .catch(() => {})
    .then(async () => {
      const target = await dependencies.resolveCodexDesktopMessageTarget(payload);
      if (!target || target.selectionMode === 'unresolved' || !target.sessionTitle) {
        return {
          skipped: true,
          reason: 'session-unresolved',
          error: 'Could not resolve the target Codex desktop session title.',
          target: target || null,
        };
      }

      const command = buildCodexAppMessageRelayCommand({
        project: target.projectDisplayName,
        session: target.sessionTitle,
        message: payload.message,
      });
      const relayOptions = {
        sessionId: relaySessionId,
        cwd: process.env.MOBILE_CODEX_APP_MESSAGE_RELAY_CWD || DEFAULT_RELAY_CWD,
        model: process.env.MOBILE_CODEX_APP_MESSAGE_RELAY_MODEL || DEFAULT_RELAY_MODEL,
        modelReasoningEffort:
          process.env.MOBILE_CODEX_APP_MESSAGE_RELAY_REASONING_EFFORT ||
          DEFAULT_RELAY_REASONING_EFFORT,
      };
      const runRelayCommand =
        dependencies.runRelayCommand || runCodexAppMessageRelayCommand;
      await runRelayCommand(command, relayOptions);
      return {
        skipped: false,
        sessionId: payload.sessionId || null,
        target,
        relaySessionId,
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
