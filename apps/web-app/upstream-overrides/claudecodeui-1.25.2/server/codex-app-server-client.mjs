import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexThreadReader, resolveSharedCodexEndpoint } from './codex-core/index.js';

/** GPL web adapter around the shared MIT public app-server client. */
export function createCodexAppServerClient({
  cliPath = process.env.MOBILE_CODEX_CLI,
  cwd = process.cwd(), requestTimeoutMs = 30_000,
  spawnImpl, sharedServer = false, remote,
} = {}) {
  if (!cliPath || typeof cliPath !== 'string') {
    throw new Error('MOBILE_CODEX_CLI is required for Codex app-server requests.');
  }
  const reader = new CodexThreadReader({
    binary: cliPath, cwd: path.resolve(cwd), profileStateDir: os.tmpdir(),
    inheritCodexHome: true, timeoutMs: requestTimeoutMs, spawnImpl,
    sharedServer, remote, passive: true,
    clientInfo: { name: 'mobile-codex-helper', title: 'Codex Web', version: '1.0.0' },
  });
  return {
    async request(method, params) {
      if (method === 'initialize') { await reader.connect(); return {}; }
      return reader.rpc(method, params);
    },
    notify(method, params) { if (method !== 'initialized') reader.notify(method, params); },
    waitForNotification: (...args) => reader.waitForNotification(...args),
    updateThreadSettings: (...args) => reader.updateThreadSettings(...args),
    joinActiveThread: (...args) => reader.joinActiveThread(...args),
    readReconciledThread: (...args) => reader.readReconciledThread(...args),
    close: () => reader.stop(),
  };
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
  const endpoint = await (dependencies.resolveEndpoint || resolveSharedCodexEndpoint)({
    remote: process.env.MOBILE_CODEX_QUEUE_REMOTE || process.env.CODEX_QUEUE_REMOTE,
  });
  const client = createClient({ cwd, sharedServer: Boolean(endpoint), remote: endpoint });
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
