import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const vendorRequire = createRequire(new URL('../vendor/claudecodeui-1.25.2/package.json', import.meta.url));
const sqlite3 = vendorRequire('sqlite3');
const { open } = vendorRequire('sqlite');

function readArguments(argv) {
  const options = {
    apply: false,
    archiveSources: false,
    cli: process.env.MOBILE_CODEX_CLI || '',
    projectPath: '',
    projectId: '',
    threadIds: [],
    existingMappings: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--archive-sources') {
      options.archiveSources = true;
    } else if (argument === '--cli') {
      options.cli = argv[++index] || '';
    } else if (argument === '--project-path') {
      options.projectPath = argv[++index] || '';
    } else if (argument === '--project-id') {
      options.projectId = argv[++index] || '';
    } else if (argument === '--thread') {
      options.threadIds.push(argv[++index] || '');
    } else if (argument === '--existing') {
      const mapping = argv[++index] || '';
      const [sourceThreadId, migratedThreadId] = mapping.split(':');
      if (!sourceThreadId || !migratedThreadId) {
        throw new Error(`Invalid --existing mapping: ${mapping}`);
      }
      options.existingMappings.push({ sourceThreadId, migratedThreadId });
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  options.threadIds = [...new Set(options.threadIds.filter(Boolean))];
  if (
    !options.cli ||
    !options.projectPath ||
    !options.projectId ||
    (options.threadIds.length === 0 && options.existingMappings.length === 0)
  ) {
    throw new Error(
      'Usage: node scripts/migrate-codex-legacy-sessions.mjs ' +
      '--cli <codex.exe> --project-path <path> --project-id <id> ' +
      '--thread <id> [--thread <id> ...] ' +
      '[--existing <source-id>:<migrated-id> ...] [--archive-sources] [--apply]',
    );
  }

  return options;
}

async function findCodexStateDatabase() {
  const codexHome = path.join(os.homedir(), '.codex');
  const candidates = (await fs.readdir(codexHome, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^state(?:_(\d+))?\.sqlite$/i.test(entry.name))
    .map((entry) => {
      const match = entry.name.match(/^state(?:_(\d+))?\.sqlite$/i);
      return {
        version: match?.[1] ? Number.parseInt(match[1], 10) : 0,
        fullPath: path.join(codexHome, entry.name),
      };
    })
    .sort((left, right) => right.version - left.version);

  if (!candidates[0]) {
    throw new Error('Could not find ~/.codex/state*.sqlite');
  }
  return candidates[0].fullPath;
}

async function normalizeMigratedThreads(mappings, options) {
  const stateDatabase = await findCodexStateDatabase();
  const cliVersion = execFileSync(options.cli, ['--version'], { encoding: 'utf8' })
    .trim()
    .replace(/^codex-cli\s+/i, '');
  const db = await open({ filename: stateDatabase, driver: sqlite3.Database });

  try {
    await db.exec('BEGIN IMMEDIATE');
    for (const { sourceThreadId, migratedThreadId } of mappings) {
      const source = await db.get(
        `SELECT title, name, first_user_message, preview
           FROM threads
          WHERE id = ?`,
        sourceThreadId,
      );
      const migrated = await db.get(
        'SELECT rollout_path FROM threads WHERE id = ?',
        migratedThreadId,
      );
      if (!source || !migrated?.rollout_path) {
        throw new Error(`Missing source or migrated thread row for ${sourceThreadId} -> ${migratedThreadId}`);
      }

      const rolloutPath = migrated.rollout_path.replace(/^\\\\\?\\/, '');
      const rawRollout = await fs.readFile(rolloutPath, 'utf8');
      const newlineIndex = rawRollout.indexOf('\n');
      const firstLine = newlineIndex >= 0 ? rawRollout.slice(0, newlineIndex) : rawRollout;
      const remainder = newlineIndex >= 0 ? rawRollout.slice(newlineIndex) : '';
      const sessionMetadata = JSON.parse(firstLine);
      if (sessionMetadata?.type !== 'session_meta' || !sessionMetadata.payload) {
        throw new Error(`Unexpected rollout header: ${rolloutPath}`);
      }

      sessionMetadata.payload.source = 'cli';
      sessionMetadata.payload.originator = 'codex_exec';
      sessionMetadata.payload.cli_version = cliVersion;
      const temporaryPath = `${rolloutPath}.mobile-codex-migration.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(sessionMetadata)}${remainder}`, 'utf8');
      await fs.rename(temporaryPath, rolloutPath);

      await db.run(
        `UPDATE threads
            SET source = 'cli',
                originator = 'codex_exec',
                cli_version = ?,
                thread_source = 'user',
                project_id = ?,
                title = ?,
                name = ?,
                first_user_message = ?,
                preview = ?
          WHERE id = ?`,
        cliVersion,
        options.projectId,
        source.title || '',
        source.name || source.title || null,
        source.first_user_message || '',
        source.preview || source.first_user_message || '',
        migratedThreadId,
      );
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await db.close();
  }
}

async function updateDesktopProjectAssignments(mappings, canonicalProjectId) {
  const codexHome = path.join(os.homedir(), '.codex');
  const globalStatePath = path.join(codexHome, '.codex-global-state.json');
  const rawState = await fs.readFile(globalStatePath, 'utf8');
  const state = JSON.parse(rawState);
  const projectMappings = state?.['app-server-project-id-by-legacy-project-id-by-host'];
  let legacyProjectId = null;

  for (const hostMappings of Object.values(projectMappings || {})) {
    if (!hostMappings || typeof hostMappings !== 'object') {
      continue;
    }
    const match = Object.entries(hostMappings).find(([, appServerProjectId]) => (
      appServerProjectId === canonicalProjectId
    ));
    if (match) {
      [legacyProjectId] = match;
      break;
    }
  }

  if (!legacyProjectId) {
    throw new Error(`Could not map canonical project ${canonicalProjectId} to a Desktop project id`);
  }

  const assignments =
    state['thread-project-assignments'] && typeof state['thread-project-assignments'] === 'object'
      ? state['thread-project-assignments']
      : {};
  for (const { migratedThreadId } of mappings) {
    assignments[migratedThreadId] = {
      projectKind: 'local',
      projectId: legacyProjectId,
    };
  }
  state['thread-project-assignments'] = assignments;

  const backupDirectory = path.join(codexHome, 'backups');
  await fs.mkdir(backupDirectory, { recursive: true });
  const backupPath = path.join(
    backupDirectory,
    `.codex-global-state.before-mobile-session-migration-${Date.now()}.json`,
  );
  await fs.copyFile(globalStatePath, backupPath);
  const temporaryPath = `${globalStatePath}.mobile-codex-migration.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(state), 'utf8');
  await fs.rename(temporaryPath, globalStatePath);
  return { legacyProjectId, backupPath };
}

function createAppServerClient(cliPath, cwd) {
  const child = spawn(cliPath, ['app-server', '--stdio'], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  let requestId = 0;
  let stdoutBuffer = '';
  let stderr = '';

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

      if (message.id === undefined || !pending.has(String(message.id))) {
        continue;
      }

      const entry = pending.get(String(message.id));
      pending.delete(String(message.id));
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(JSON.stringify(message.error)));
      } else {
        entry.resolve(message.result);
      }
    }
  });

  const request = (method, params, timeoutMs = 120_000) => new Promise((resolve, reject) => {
    requestId += 1;
    const id = String(requestId);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out${stderr ? `: ${stderr.trim()}` : ''}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
  };

  const close = async () => {
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

  return { child, close, notify, request };
}

async function main() {
  const options = readArguments(process.argv.slice(2));
  if (!options.apply) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      cli: options.cli,
      archiveSources: options.archiveSources,
      projectPath: options.projectPath,
      projectId: options.projectId,
      threadIds: options.threadIds,
      existingMappings: options.existingMappings,
    }, null, 2));
    return;
  }

  const client = createAppServerClient(options.cli, options.projectPath);
  const results = [...options.existingMappings];
  try {
    await client.request('initialize', {
      clientInfo: { name: 'mobile-codex-session-migration', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');

    for (const { migratedThreadId } of options.existingMappings) {
      await client.request('thread/metadata/update', {
        threadId: migratedThreadId,
        projectId: options.projectId,
      });
    }

    for (const sourceThreadId of options.threadIds) {
      const forkResult = await client.request('thread/fork', {
        threadId: sourceThreadId,
        cwd: options.projectPath,
        threadSource: 'cli',
        excludeTurns: true,
        ephemeral: false,
      });
      const migratedThreadId = forkResult?.thread?.id;
      if (!migratedThreadId) {
        throw new Error(`thread/fork returned no thread id for ${sourceThreadId}`);
      }

      await client.request('thread/metadata/update', {
        threadId: migratedThreadId,
        projectId: options.projectId,
      });
      results.push({ sourceThreadId, migratedThreadId });
    }

    if (options.archiveSources) {
      for (const sourceThreadId of new Set(results.map((result) => result.sourceThreadId))) {
        await client.request('thread/archive', { threadId: sourceThreadId });
      }
    }
  } finally {
    await client.close();
  }

  await normalizeMigratedThreads(results, options);
  const desktopAssignment = await updateDesktopProjectAssignments(results, options.projectId);

  console.log(JSON.stringify({ mode: 'apply', results, desktopAssignment }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
