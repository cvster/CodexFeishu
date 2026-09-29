import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function createCodexAppServerClient({
  cliPath = process.env.MOBILE_CODEX_CLI,
  cliArgs = ['app-server', '--stdio'],
  cwd = process.cwd(),
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  spawnImpl = spawn,
} = {}) {
  if (!cliPath || typeof cliPath !== 'string') {
    throw new Error('MOBILE_CODEX_CLI is required for Codex app-server requests.');
  }

  const child = spawnImpl(cliPath, cliArgs, {
    cwd: path.resolve(cwd),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  const notificationWaiters = new Set();
  let nextRequestId = 0;
  let stdoutBuffer = '';
  let stderr = '';
  let closed = false;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        break;
      }

      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      if (message.id === undefined && typeof message.method === 'string') {
        for (const waiter of [...notificationWaiters]) {
          if (waiter.method !== message.method || !waiter.predicate(message.params)) {
            continue;
          }
          notificationWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(message.params);
        }
        continue;
      }

      const key = String(message.id ?? '');
      const entry = pending.get(key);
      if (!entry) {
        continue;
      }

      pending.delete(key);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        entry.resolve(message.result);
      }
    }
  });

  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    for (const waiter of notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    notificationWaiters.clear();
  };

  child.once('error', (error) => rejectPending(error));
  child.once('exit', (code) => {
    if (!closed && pending.size > 0) {
      rejectPending(new Error(`Codex app-server exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    }
  });

  const request = (method, params) => new Promise((resolve, reject) => {
    nextRequestId += 1;
    const id = String(nextRequestId);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out${stderr ? `: ${stderr.trim()}` : ''}`));
    }, requestTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
  };

  const waitForNotification = (
    method,
    predicate = () => true,
    timeoutMs = 30 * 60_000,
  ) => new Promise((resolve, reject) => {
    const waiter = { method, predicate, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      notificationWaiters.delete(waiter);
      reject(new Error(`${method} notification timed out${stderr ? `: ${stderr.trim()}` : ''}`));
    }, timeoutMs);
    notificationWaiters.add(waiter);
  });

  const close = async () => {
    closed = true;
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return { close, notify, request, waitForNotification };
}

function normalizeCodexPath(value) {
  return path.resolve(String(value || '').replace(/^\\\\\?\\/, ''));
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(normalizeCodexPath(parentPath), normalizeCodexPath(childPath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function resolveCodexStateDbPath(codexHome) {
  const entries = await fs.readdir(codexHome, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^state_(\d+)\.sqlite$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      version: Number(entry.name.match(/^state_(\d+)\.sqlite$/)?.[1] || 0),
    }))
    .sort((left, right) => right.version - left.version);
  if (!candidates.length) {
    throw new Error(`Codex state database not found in ${codexHome}`);
  }
  return path.join(codexHome, candidates[0].name);
}

export async function archiveCodexThreadInStateStore(
  { sessionId },
  dependencies = {},
) {
  const codexHome = dependencies.codexHome
    || process.env.CODEX_HOME
    || path.join(os.homedir(), '.codex');
  const stateDbPath = dependencies.stateDbPath || await resolveCodexStateDbPath(codexHome);
  let openDatabase = dependencies.openDatabase;
  if (!openDatabase) {
    const { default: Database } = await import('better-sqlite3');
    openDatabase = (filePath) => new Database(filePath);
  }
  const fileSystem = dependencies.fileSystem || fs;
  const db = openDatabase(stateDbPath);

  let sourcePath;
  let destinationPath;
  let moved = false;
  try {
    const thread = db.prepare(
      'SELECT id, rollout_path, archived FROM threads WHERE id = ?',
    ).get(sessionId);
    if (!thread) {
      throw new Error(`Codex thread not found in state store: ${sessionId}`);
    }
    if (thread.archived) {
      return { skipped: false, sessionId, fallback: 'state-store', alreadyArchived: true };
    }

    sourcePath = normalizeCodexPath(thread.rollout_path);
    const sessionsRoot = path.join(codexHome, 'sessions');
    const archiveRoot = path.join(codexHome, 'archived_sessions');
    if (!isPathInside(sessionsRoot, sourcePath) || path.extname(sourcePath).toLowerCase() !== '.jsonl') {
      throw new Error(`Refusing to archive rollout outside the Codex sessions directory: ${sourcePath}`);
    }

    await fileSystem.mkdir(archiveRoot, { recursive: true });
    destinationPath = path.join(archiveRoot, path.basename(sourcePath));
    await fileSystem.rename(sourcePath, destinationPath);
    moved = true;

    const archivedAt = Math.floor(Date.now() / 1000);
    const update = db.prepare(`
      UPDATE threads
      SET rollout_path = ?, archived = 1, archived_at = ?, updated_at = ?
      WHERE id = ? AND archived = 0
    `).run(destinationPath, archivedAt, archivedAt, sessionId);
    if (update.changes !== 1) {
      throw new Error(`Codex thread archive state changed unexpectedly: ${sessionId}`);
    }

    return { skipped: false, sessionId, fallback: 'state-store' };
  } catch (error) {
    if (moved && sourcePath && destinationPath) {
      try {
        await fileSystem.rename(destinationPath, sourcePath);
      } catch (rollbackError) {
        error.message = `${error.message}; rollout rollback failed: ${rollbackError.message}`;
      }
    }
    throw error;
  } finally {
    db.close?.();
  }
}

export async function archiveCodexAppThread({ sessionId, projectPath }, dependencies = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('A Codex session ID is required for archive.');
  }

  const cwd = typeof projectPath === 'string' && !projectPath.startsWith('codex://')
    ? projectPath
    : process.cwd();
  const createClient = dependencies.createClient || createCodexAppServerClient;
  const archiveInStateStore = dependencies.archiveInStateStore || archiveCodexThreadInStateStore;
  const client = createClient({ cwd });
  try {
    await client.request('initialize', {
      clientInfo: { name: 'mobile-codex-helper', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    try {
      await client.request('thread/archive', { threadId: sessionId });
      return { skipped: false, sessionId };
    } catch (error) {
      if (!/already has an active writer/i.test(String(error?.message || ''))) {
        throw error;
      }
      return archiveInStateStore({ sessionId, projectPath });
    }
  } finally {
    await client.close();
  }
}
