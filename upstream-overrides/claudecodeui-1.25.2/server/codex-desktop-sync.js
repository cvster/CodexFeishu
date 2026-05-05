import { spawn } from 'child_process';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
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
const AUTOMATION_DEPENDENCY_PATHS = [
  AUTOMATION_RUNNER,
  path.join(REPO_ROOT, 'scripts', 'codex_desktop_automation.py'),
];
const MAX_METADATA_ATTEMPTS = 6;
const METADATA_RETRY_DELAY_MS = 750;
const AUTOMATION_TIMEOUT_MS = 90000;
const AUTOMATION_WORKER_READY_TIMEOUT_MS = 45000;
const DESKTOP_AUTOMATION_WORKER_ENABLED =
  process.env.MOBILE_CODEX_DESKTOP_AUTOMATION_WORKER !== 'false';
const CODEX_PROJECTLESS_PROJECT_PATH = 'codex://projectless';
const CODEX_PROJECTLESS_PROJECT_DISPLAY_NAME = '无项目会话';
const SIDE_EFFECTFUL_SEND_COMMANDS = new Set(['send-message', 'send-message-current', 'archive-session']);
const automationQueues = new Map();
let desktopAutomationWorker = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
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
  if (projectPath === CODEX_PROJECTLESS_PROJECT_PATH) {
    return CODEX_PROJECTLESS_PROJECT_DISPLAY_NAME;
  }

  const resolved = path.resolve(projectPath);
  const parsed = path.parse(resolved);
  return path.basename(resolved) || parsed.root || resolved;
}

async function isCodexProjectlessSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return false;
  }

  try {
    const statePath = path.join(os.homedir(), '.codex', '.codex-global-state.json');
    const rawState = await fs.readFile(statePath, 'utf8');
    const state = JSON.parse(rawState);
    const projectlessThreadIds = state?.['projectless-thread-ids'];
    return Array.isArray(projectlessThreadIds) && projectlessThreadIds.includes(sessionId.trim());
  } catch {
    return false;
  }
}

async function normalizeCodexDesktopProjectPath(payload) {
  if (await isCodexProjectlessSession(payload?.sessionId)) {
    return {
      ...payload,
      projectPath: CODEX_PROJECTLESS_PROJECT_PATH,
    };
  }

  return payload;
}

function isCodexProjectlessProjectPath(projectPath) {
  return projectPath === CODEX_PROJECTLESS_PROJECT_PATH;
}

function encodeDesktopAutomationText(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

function pushDesktopAutomationTextArg(args, flag, value) {
  const normalized = toComparableText(value);
  if (!normalized) {
    return;
  }

  args.push(flag, normalized);
  args.push(`${flag}-b64`, encodeDesktopAutomationText(normalized));
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

function terminateProcessTree(child) {
  if (!child || child.killed) {
    return;
  }

  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
    });
    killer.on('error', () => {
      child.kill();
    });
    return;
  }

  child.kill();
}

function runDesktopAutomationOnce(args) {
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
      terminateProcessTree(child);
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

async function getDesktopAutomationFingerprint() {
  const entries = await Promise.all(
    AUTOMATION_DEPENDENCY_PATHS.map(async (dependencyPath) => {
      try {
        const stats = await fs.stat(dependencyPath);
        return `${dependencyPath}:${stats.mtimeMs}:${stats.size}`;
      } catch {
        return `${dependencyPath}:missing`;
      }
    }),
  );
  return entries.join('|');
}

function renderWorkerPayload(payload, asJson = false) {
  if (asJson || (payload && typeof payload === 'object' && !Array.isArray(payload))) {
    return JSON.stringify(payload, null, 2);
  }

  if (Array.isArray(payload)) {
    return payload.map((entry) => JSON.stringify(entry)).join('\n');
  }

  return typeof payload === 'string' ? payload : String(payload ?? '');
}

class DesktopAutomationWorkerClient {
  constructor() {
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.scriptFingerprint = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.requestCounter = 0;
    this.pendingRequests = new Map();
  }

  async ensureStarted() {
    const scriptFingerprint = await getDesktopAutomationFingerprint();

    if (this.ready && this.child && !this.child.killed) {
      if (this.scriptFingerprint === scriptFingerprint) {
        return;
      }

      console.log('[Codex Desktop Worker] Automation files changed; restarting worker.');
      this._terminateWorker(new Error('Desktop automation files changed; restarting worker.'));
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AUTOMATION_RUNNER, 'worker'],
        {
          cwd: REPO_ROOT,
          windowsHide: true,
        },
      );

      this.child = child;
      this.ready = false;
      this.stdoutBuffer = '';
      this.stderrBuffer = '';

      const cleanupStartup = () => {
        clearTimeout(readyTimeout);
      };

      const failStartup = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupStartup();
        error.desktopWorkerStartup = true;
        this._terminateWorker(error);
        reject(error);
      };

      const readyTimeout = setTimeout(() => {
        failStartup(new Error(`Desktop automation worker did not become ready within ${AUTOMATION_WORKER_READY_TIMEOUT_MS} ms.`));
      }, AUTOMATION_WORKER_READY_TIMEOUT_MS);

      child.stdout.on('data', (chunk) => {
        this._handleStdout(chunk, {
          onReady: () => {
            if (settled) {
              return;
            }
            settled = true;
            cleanupStartup();
            this.ready = true;
            this.scriptFingerprint = scriptFingerprint;
            resolve();
          },
        });
      });

      child.stderr.on('data', (chunk) => {
        this.stderrBuffer += chunk.toString();
      });

      child.on('error', (error) => {
        failStartup(error);
      });

      child.on('close', (code, signal) => {
        const reason = new Error(
          `Desktop automation worker exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}. ${
            this.stderrBuffer.trim() || 'No stderr output.'
          }`,
        );
        if (!settled) {
          failStartup(reason);
          return;
        }
        this._handleWorkerExit(reason);
      });
    }).finally(() => {
      if (!this.ready) {
        this.startPromise = null;
      }
    });

    return this.startPromise;
  }

  async run(args) {
    await this.ensureStarted();

    if (!this.child || this.child.killed || this.child.exitCode !== null || !this.child.stdin?.writable) {
      const error = new Error('Desktop automation worker is not accepting requests.');
      error.desktopWorkerRequestNotSent = true;
      this._handleWorkerExit(error);
      throw error;
    }

    const requestId = `${Date.now()}-${++this.requestCounter}`;
    const request = { id: requestId, argv: args };

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        const error = new Error(`Desktop automation worker request timed out after ${AUTOMATION_TIMEOUT_MS} ms.`);
        this._terminateWorker(error);
        reject(error);
      }, AUTOMATION_TIMEOUT_MS);

      this.pendingRequests.set(requestId, {
        resolve: (message) => {
          clearTimeout(timeoutHandle);
          if (!message.ok) {
            reject(
              new Error(
                [message.error || 'Desktop automation worker request failed.', message.traceback || '']
                  .filter(Boolean)
                  .join('\n'),
              ),
            );
            return;
          }

          resolve({
            stdout: renderWorkerPayload(message.payload, message.asJson),
            stderr: '',
          });
        },
        reject: (error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        },
      });

      try {
        this.child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        clearTimeout(timeoutHandle);
        this.pendingRequests.delete(requestId);
        error.desktopWorkerRequestNotSent = true;
        this._handleWorkerExit(error);
        reject(error);
      }
    });
  }

  _handleStdout(chunk, callbacks = {}) {
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let message = null;
      try {
        message = JSON.parse(trimmed);
      } catch (error) {
        console.warn('[Codex Desktop Worker] Failed to parse stdout line:', trimmed);
        continue;
      }

      if (message?.event === 'ready') {
        callbacks.onReady?.();
        continue;
      }

      if (message?.id) {
        const pending = this.pendingRequests.get(message.id);
        if (!pending) {
          continue;
        }

        this.pendingRequests.delete(message.id);
        pending.resolve(message);
      }
    }
  }

  _handleWorkerExit(error) {
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.scriptFingerprint = null;

    for (const request of pending) {
      request.reject(error);
    }
  }

  _terminateWorker(error) {
    terminateProcessTree(this.child);
    this._handleWorkerExit(error);
  }
}

function getDesktopAutomationWorker() {
  if (!desktopAutomationWorker) {
    desktopAutomationWorker = new DesktopAutomationWorkerClient();
  }
  return desktopAutomationWorker;
}

function warmDesktopAutomationWorker() {
  if (!DESKTOP_SYNC_ENABLED || !DESKTOP_AUTOMATION_WORKER_ENABLED) {
    return;
  }

  getDesktopAutomationWorker()
    .ensureStarted()
    .then(() => {
      console.log('[Codex Desktop Worker] Ready.');
    })
    .catch((error) => {
      console.warn('[Codex Desktop Worker] Warmup failed, will fall back to one-shot mode:', error.message);
    });
}

async function runDesktopAutomation(args) {
  const commandName = Array.isArray(args) && typeof args[0] === 'string' ? args[0] : '';
  const isSideEffectfulSend = SIDE_EFFECTFUL_SEND_COMMANDS.has(commandName);

  if (DESKTOP_AUTOMATION_WORKER_ENABLED) {
    try {
      return await getDesktopAutomationWorker().run(args);
    } catch (error) {
      if (isSideEffectfulSend && !error?.desktopWorkerStartup && !error?.desktopWorkerRequestNotSent) {
        throw error;
      }
      console.warn('[Codex Desktop Worker] Falling back to one-shot automation:', error.message);
    }
  }

  return runDesktopAutomationOnce(args);
}

if (DESKTOP_SYNC_ENABLED && DESKTOP_AUTOMATION_WORKER_ENABLED) {
  const warmupHandle = setTimeout(() => {
    warmDesktopAutomationWorker();
  }, 1000);
  warmupHandle.unref?.();
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
  preferImmediateHint = false,
  allowSessionTitleHintFallback = false,
}) {
  const projectDisplayName = getProjectDisplayName(projectPath);
  const fallbackTitle = truncateSessionHint(sessionTitleHint);

  if (preferImmediateHint && fallbackTitle) {
    return {
      projectDisplayName,
      sessionTitle: fallbackTitle,
      selectionMode: 'session-hint',
      resolutionSource: 'hint',
    };
  }

  for (let attempt = 0; attempt < MAX_METADATA_ATTEMPTS; attempt += 1) {
    const sessions = await getCodexSessions(projectPath, { limit: 0 });
    const matchingSession = sessions.find((session) => session.id === sessionId);
    if (matchingSession) {
      const title = truncateSessionHint(matchingSession.title || null);
      const resolvedTarget = {
        projectDisplayName,
        sessionTitle: title,
        selectionMode: title ? 'session-title' : 'latest',
        resolutionSource: 'metadata',
      };
      return resolvedTarget;
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
      resolutionSource: 'latest-fallback',
    };
  }

  if (allowSessionTitleHintFallback && fallbackTitle) {
    return {
      projectDisplayName,
      sessionTitle: fallbackTitle,
      selectionMode: 'session-hint',
      resolutionSource: 'hint-fallback',
    };
  }

  return {
    projectDisplayName,
    sessionTitle: null,
    selectionMode: 'unresolved',
    resolutionSource: 'unresolved',
  };
}

async function waitForNewCodexSessionId(projectPath, previousSessionIds) {
  const previousIds = new Set(previousSessionIds);
  for (let attempt = 0; attempt < MAX_METADATA_ATTEMPTS; attempt += 1) {
    const sessions = await getCodexSessions(projectPath, { limit: 0 });
    const newSession = sessions.find(
      (session) => typeof session.id === 'string' && !previousIds.has(session.id),
    );
    if (newSession?.id) {
      return newSession.id;
    }

    if (attempt < MAX_METADATA_ATTEMPTS - 1) {
      await sleep(METADATA_RETRY_DELAY_MS);
    }
  }

  return null;
}

async function executeDesktopSync({
  sessionId,
  projectPath,
  sessionTitleHint,
  allowLatestFallback,
  reason,
  sourceContext,
}) {
  const normalizedPayload = await normalizeCodexDesktopProjectPath({ sessionId, projectPath });
  projectPath = normalizedPayload.projectPath;

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
      ? ['open-latest-session', '--json']
      : ['open-session', '--json'];

  pushDesktopAutomationTextArg(automationArgs, '--project', target.projectDisplayName);
  if (target.selectionMode !== 'latest' && target.sessionTitle) {
    pushDesktopAutomationTextArg(automationArgs, '--session', target.sessionTitle);
  }

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

export function enqueueCodexDesktopArchive(payload) {
  const queueKey = payload.sessionId || `${payload.projectPath}:desktop-archive`;
  const previous = automationQueues.get(queueKey) || Promise.resolve();
  const enqueuedAt = Date.now();

  const next = previous
    .catch(() => {})
    .then(async () => {
      const archivePayload = await normalizeCodexDesktopProjectPath(payload);
      const archiveStartedAt = Date.now();
      const queueWaitMs = archiveStartedAt - enqueuedAt;
      if (!DESKTOP_SYNC_ENABLED) {
        return {
          skipped: true,
          reason: 'desktop-automation-disabled',
        };
      }

      if (!archivePayload.sessionId || !archivePayload.projectPath) {
        return {
          skipped: true,
          reason: 'missing-session-or-project',
        };
      }

      const resolveStartedAt = Date.now();
      const target = await resolveNavigationTarget({
        sessionId: archivePayload.sessionId,
        projectPath: archivePayload.projectPath,
        sessionTitleHint: archivePayload.sessionTitleHint || null,
        allowLatestFallback: false,
        preferImmediateHint: Boolean(archivePayload.sessionTitleHint),
        allowSessionTitleHintFallback: Boolean(archivePayload.sessionTitleHint),
      });
      const resolveMs = elapsedMs(resolveStartedAt);

      if (target.selectionMode === 'unresolved' || !target.sessionTitle) {
        return {
          skipped: true,
          reason: 'session-unresolved',
          error: 'Could not resolve the target Codex desktop session title.',
          target,
        };
      }

      const automationArgs = ['archive-session', '--json'];
      pushDesktopAutomationTextArg(automationArgs, '--project', target.projectDisplayName);
      pushDesktopAutomationTextArg(automationArgs, '--session', target.sessionTitle);

      const automationStartedAt = Date.now();
      const result = await runDesktopAutomation(automationArgs);
      const automationMs = elapsedMs(automationStartedAt);
      console.log(
        `[Codex Desktop Archive] archived -> ${target.projectDisplayName} / ${
          target.sessionTitle
        } (${target.selectionMode}, ${target.resolutionSource || 'unknown'}) | queue=${queueWaitMs}ms resolve=${resolveMs}ms automation=${automationMs}ms total=${elapsedMs(
          archiveStartedAt,
        )}ms`,
      );
      if (result.stderr) {
        console.warn('[Codex Desktop Archive] stderr:', result.stderr);
      }

      return {
        skipped: false,
        target,
        output: result.stdout,
      };
    })
    .catch((error) => {
      console.warn('[Codex Desktop Archive] Failed:', error.message);
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
  const enqueuedAt = Date.now();

  const next = previous
    .catch(() => {})
    .then(async () => {
      const bridgePayload = await normalizeCodexDesktopProjectPath(payload);
      const bridgeStartedAt = Date.now();
      const queueWaitMs = bridgeStartedAt - enqueuedAt;
      const normalizedContext = normalizeSourceContext(bridgePayload.sourceContext);
      if (!shouldSyncDesktop(normalizedContext)) {
        return {
          skipped: true,
          reason: 'disabled-for-source',
        };
      }

      const messageText = typeof bridgePayload.message === 'string' ? bridgePayload.message : '';

      if ((!bridgePayload.sessionId && !bridgePayload.newSession) || !bridgePayload.projectPath || messageText.trim().length === 0) {
        return {
          skipped: true,
          reason: 'missing-session-project-or-message',
        };
      }

      const resolveStartedAt = Date.now();
      const previousSessionIds = bridgePayload.newSession
        ? (await getCodexSessions(bridgePayload.projectPath, { limit: 0 }))
            .map((session) => session.id)
            .filter((sessionId) => typeof sessionId === 'string')
        : [];
      let target = bridgePayload.newSession
        ? {
            projectDisplayName: getProjectDisplayName(bridgePayload.projectPath),
            sessionTitle: null,
            selectionMode: 'new-session',
            resolutionSource: 'new-session',
          }
        : await resolveNavigationTarget({
            sessionId: bridgePayload.sessionId,
            projectPath: bridgePayload.projectPath,
            sessionTitleHint: bridgePayload.sessionTitleHint || null,
            allowLatestFallback: false,
            preferImmediateHint: Boolean(bridgePayload.sessionTitleHint),
            allowSessionTitleHintFallback: Boolean(bridgePayload.sessionTitleHint),
          });
      console.log(
        '[mobile-codex][bridge-target]',
        JSON.stringify({
          projectPath: bridgePayload.projectPath,
          sessionId: bridgePayload.sessionId,
          newSession: Boolean(bridgePayload.newSession),
          resolvedProjectDisplayName: target.projectDisplayName,
          resolvedSessionTitle: target.sessionTitle,
          selectionMode: target.selectionMode,
          resolutionSource: target.resolutionSource,
        }),
      );
      const initialResolveMs = elapsedMs(resolveStartedAt);

      if (target.selectionMode === 'unresolved') {
        return {
          skipped: true,
          reason: 'session-unresolved',
          error: 'Could not resolve the target Codex desktop session.',
          target,
        };
      }

      return withDesktopMessageFile(messageText, async (messagePath) => {
        const runSendAutomation = async (resolvedTarget) => {
          const projectlessTarget = isCodexProjectlessProjectPath(bridgePayload.projectPath);
          const automationArgs = [
            projectlessTarget ? 'send-message-current' : 'send-message',
            '--message-file',
            messagePath,
            '--json',
          ];

          if (projectlessTarget) {
            if (resolvedTarget.selectionMode === 'new-session') {
              automationArgs.push('--new-session');
            } else if (bridgePayload.sessionId) {
              automationArgs.push('--session-id', bridgePayload.sessionId);
            }
          } else {
            pushDesktopAutomationTextArg(automationArgs, '--project', resolvedTarget.projectDisplayName);
            if (resolvedTarget.selectionMode === 'new-session') {
              automationArgs.push('--new-session');
            } else if (resolvedTarget.selectionMode !== 'latest' && resolvedTarget.sessionTitle) {
              pushDesktopAutomationTextArg(automationArgs, '--session', resolvedTarget.sessionTitle);
            }
          }

          return runDesktopAutomation(automationArgs);
        };

        let result;
        let automationStartedAt = Date.now();

        try {
          result = await runSendAutomation(target);
        } catch (error) {
          if (bridgePayload.newSession) {
            throw error;
          }

          const shouldRetryWithMetadata =
            typeof bridgePayload.sessionId === 'string' &&
            typeof bridgePayload.projectPath === 'string';

          if (!shouldRetryWithMetadata) {
            throw error;
          }

          const retryResolveStartedAt = Date.now();
          target = await resolveNavigationTarget({
            sessionId: bridgePayload.sessionId,
            projectPath: bridgePayload.projectPath,
            sessionTitleHint: bridgePayload.sessionTitleHint || null,
            allowLatestFallback: false,
            preferImmediateHint: false,
            allowSessionTitleHintFallback: Boolean(bridgePayload.sessionTitleHint),
          });
          const retryResolveMs = elapsedMs(retryResolveStartedAt);

          if (target.selectionMode === 'unresolved') {
            throw error;
          }

          automationStartedAt = Date.now();
          result = await runSendAutomation(target);
          console.log(
            `[Codex Desktop Bridge] retried metadata resolve in ${retryResolveMs}ms after hint miss.`,
          );
        }

        const automationMs = elapsedMs(automationStartedAt);
        console.log(
          `[Codex Desktop Bridge] submit -> ${target.projectDisplayName} / ${
            target.sessionTitle || '<latest>'
          } (${target.selectionMode}, ${target.resolutionSource || 'unknown'}) | queue=${queueWaitMs}ms resolve=${initialResolveMs}ms automation=${automationMs}ms total=${elapsedMs(
            bridgeStartedAt,
          )}ms`,
        );
        if (result.stderr) {
          console.warn('[Codex Desktop Bridge] stderr:', result.stderr);
        }

        const newSessionId = bridgePayload.newSession
          ? await waitForNewCodexSessionId(bridgePayload.projectPath, previousSessionIds)
          : null;

        return {
          skipped: false,
          target,
          sessionId: newSessionId,
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
