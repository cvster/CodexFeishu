import { spawn } from 'child_process';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCodexSessions } from './projects.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_SYNC_MODE = (process.env.MOBILE_CODEX_DESKTOP_SYNC_MODE || 'mobile-only').trim().toLowerCase();
const DESKTOP_SYNC_ENABLED =
  process.platform === 'win32' &&
  process.env.MOBILE_CODEX_DESKTOP_SYNC !== 'false' &&
  DEFAULT_SYNC_MODE !== 'off';
const REPO_ROOT = path.resolve(__dirname, '../../../');
const AUTOMATION_RUNNER =
  process.env.MOBILE_CODEX_DESKTOP_AUTOMATION_RUNNER ||
  path.join(REPO_ROOT, 'scripts', 'run-codex-desktop-automation.ps1');
const MAX_METADATA_ATTEMPTS = 6;
const METADATA_RETRY_DELAY_MS = 750;
const AUTOMATION_TIMEOUT_MS = 90000;
const automationQueues = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toComparableText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function truncateSessionHint(value, maxLength = 80) {
  const normalized = toComparableText(value).replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }

  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function getProjectDisplayName(projectPath) {
  const resolved = path.resolve(projectPath);
  const parsed = path.parse(resolved);
  return path.basename(resolved) || parsed.root || resolved;
}

function isLikelyMobileUserAgent(userAgent = '') {
  const normalized = userAgent.toLowerCase();
  return /(android|iphone|ipad|ipod|mobile|tablet|windows phone|kindle|silk|miuibrowser|harmonyos)/i.test(normalized);
}

function shouldSyncDesktop(sourceContext = null) {
  if (!DESKTOP_SYNC_ENABLED) {
    return false;
  }

  switch (DEFAULT_SYNC_MODE) {
    case 'always':
      return true;
    case 'mobile-only':
    default:
      return Boolean(sourceContext?.isMobile);
  }
}

function normalizeSourceContext(sourceContext = null) {
  const userAgent = sourceContext?.userAgent || '';
  return {
    isMobile: sourceContext?.isMobile ?? isLikelyMobileUserAgent(userAgent),
    userAgent,
    remoteAddress: sourceContext?.remoteAddress || null,
  };
}

function runDesktopAutomation(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AUTOMATION_RUNNER, ...args],
      {
        cwd: REPO_ROOT,
        windowsHide: true,
      },
    );

    let stdout = '';
    let stderr = '';
    const timeoutHandle = setTimeout(() => {
      child.kill();
      reject(new Error(`Desktop automation timed out after ${AUTOMATION_TIMEOUT_MS} ms`));
    }, AUTOMATION_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }

      reject(
        new Error(
          `Desktop automation exited with code ${code}. ${stderr.trim() || stdout.trim() || 'No output.'}`,
        ),
      );
    });
  });
}

async function withDesktopMessageFile(message, callback) {
  const bridgeDir = path.join(REPO_ROOT, 'tmp', 'desktop-bridge');
  await fs.mkdir(bridgeDir, { recursive: true });
  const messagePath = path.join(bridgeDir, `${crypto.randomUUID()}.txt`);

  await fs.writeFile(messagePath, message, 'utf8');
  try {
    return await callback(messagePath);
  } finally {
    await fs.rm(messagePath, { force: true }).catch(() => {});
  }
}

async function resolveNavigationTarget({
  sessionId,
  projectPath,
  sessionTitleHint,
  allowLatestFallback,
}) {
  const projectDisplayName = getProjectDisplayName(projectPath);

  for (let attempt = 0; attempt < MAX_METADATA_ATTEMPTS; attempt += 1) {
    const sessions = await getCodexSessions(projectPath, { limit: 0 });
    const matchingSession = sessions.find((session) => session.id === sessionId);
    if (matchingSession) {
      const title = truncateSessionHint(matchingSession.summary);
      return {
        projectDisplayName,
        sessionTitle: title,
        selectionMode: title ? 'session-title' : 'latest',
      };
    }

    if (attempt < MAX_METADATA_ATTEMPTS - 1) {
      await sleep(METADATA_RETRY_DELAY_MS);
    }
  }

  if (allowLatestFallback) {
    return {
      projectDisplayName,
      sessionTitle: null,
      selectionMode: 'latest',
    };
  }

  const fallbackTitle = truncateSessionHint(sessionTitleHint);
  if (fallbackTitle) {
    return {
      projectDisplayName,
      sessionTitle: fallbackTitle,
      selectionMode: 'session-hint',
    };
  }

  return {
    projectDisplayName,
    sessionTitle: null,
    selectionMode: 'unresolved',
  };
}

async function executeDesktopSync({
  sessionId,
  projectPath,
  sessionTitleHint,
  allowLatestFallback,
  reason,
  sourceContext,
}) {
  const normalizedContext = normalizeSourceContext(sourceContext);
  if (!shouldSyncDesktop(normalizedContext)) {
    return {
      skipped: true,
      reason: 'disabled-for-source',
    };
  }

  if (!sessionId || !projectPath) {
    return {
      skipped: true,
      reason: 'missing-session-or-project',
    };
  }

  const target = await resolveNavigationTarget({
    sessionId,
    projectPath,
    sessionTitleHint,
    allowLatestFallback,
  });

  if (target.selectionMode === 'unresolved') {
    return {
      skipped: true,
      reason: 'session-unresolved',
      target,
    };
  }

  const automationArgs =
    target.selectionMode === 'latest'
      ? ['open-latest-session', '--project', target.projectDisplayName, '--json']
      : ['open-session', '--project', target.projectDisplayName, '--session', target.sessionTitle, '--json'];

  const result = await runDesktopAutomation(automationArgs);
  console.log(
    `[Codex Desktop Sync] ${reason} -> ${target.projectDisplayName} / ${
      target.sessionTitle || '<latest>'
    } (${target.selectionMode})`,
  );
  if (result.stderr) {
    console.warn('[Codex Desktop Sync] stderr:', result.stderr);
  }

  return {
    skipped: false,
    reason,
    target,
    output: result.stdout,
    sourceContext: normalizedContext,
  };
}

export function createCodexDesktopSyncContextFromRequest(request) {
  const userAgent = request?.headers?.['user-agent'] || '';
  return normalizeSourceContext({
    userAgent,
    remoteAddress: request?.socket?.remoteAddress || null,
  });
}

export function enqueueCodexDesktopSync(payload) {
  const queueKey = payload.sessionId || `${payload.projectPath}:${payload.reason || 'sync'}`;
  const previous = automationQueues.get(queueKey) || Promise.resolve();

  const next = previous
    .catch(() => {})
    .then(() => executeDesktopSync(payload))
    .catch((error) => {
      console.warn('[Codex Desktop Sync] Failed:', error.message);
      return {
        skipped: true,
        reason: 'error',
        error: error.message,
      };
    })
    .finally(() => {
      if (automationQueues.get(queueKey) === next) {
        automationQueues.delete(queueKey);
      }
    });

  automationQueues.set(queueKey, next);
  return next;
}

export function enqueueCodexDesktopMessageBridge(payload) {
  const queueKey = payload.sessionId || `${payload.projectPath}:desktop-message`;
  const previous = automationQueues.get(queueKey) || Promise.resolve();

  const next = previous
    .catch(() => {})
    .then(async () => {
      const normalizedContext = normalizeSourceContext(payload.sourceContext);
      if (!shouldSyncDesktop(normalizedContext)) {
        return {
          skipped: true,
          reason: 'disabled-for-source',
        };
      }

      const messageText = typeof payload.message === 'string' ? payload.message : '';

      if (!payload.sessionId || !payload.projectPath || messageText.trim().length === 0) {
        return {
          skipped: true,
          reason: 'missing-session-project-or-message',
        };
      }

      const target = await resolveNavigationTarget({
        sessionId: payload.sessionId,
        projectPath: payload.projectPath,
        sessionTitleHint: payload.sessionTitleHint || null,
        allowLatestFallback: true,
      });

      return withDesktopMessageFile(messageText, async (messagePath) => {
        const automationArgs = ['send-message', '--project', target.projectDisplayName, '--message-file', messagePath, '--json'];
        if (target.selectionMode !== 'latest' && target.sessionTitle) {
          automationArgs.push('--session', target.sessionTitle);
        }

        const result = await runDesktopAutomation(automationArgs);
        console.log(
          `[Codex Desktop Bridge] submit -> ${target.projectDisplayName} / ${
            target.sessionTitle || '<latest>'
          } (${target.selectionMode})`,
        );
        if (result.stderr) {
          console.warn('[Codex Desktop Bridge] stderr:', result.stderr);
        }

        return {
          skipped: false,
          target,
          output: result.stdout,
          sourceContext: normalizedContext,
        };
      });
    })
    .catch((error) => {
      console.warn('[Codex Desktop Bridge] Failed:', error.message);
      return {
        skipped: true,
        reason: 'error',
        error: error.message,
      };
    })
    .finally(() => {
      if (automationQueues.get(queueKey) === next) {
        automationQueues.delete(queueKey);
      }
    });

  automationQueues.set(queueKey, next);
  return next;
}
