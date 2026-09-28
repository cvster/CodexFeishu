import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexThreadReader } from '../../src/session/codex-thread-reader.js';

describe('CodexThreadReader', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reuses one app-server process for multiple thread reads', async () => {
    const fake = await createFakeCodex();
    cleanup.push(fake.dir);
    const reader = new CodexThreadReader({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: true,
      timeoutMs: 2_000,
    });

    await expect(reader.readThread('thread-a')).resolves.toMatchObject({
      id: 'thread-a',
      turns: [{ id: 'turn-thread-a', status: 'completed' }],
    });
    await expect(reader.readThread('thread-b')).resolves.toMatchObject({
      id: 'thread-b',
      turns: [{ id: 'turn-thread-b', status: 'completed' }],
    });
    await expect(reader.listRecentThreads()).resolves.toEqual([
      { id: 'thread-b', updatedAtMs: 12_000 },
    ]);
    await reader.stop();

    const starts = (await readFile(fake.startsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    expect(starts).toHaveLength(1);
  });
});

async function createFakeCodex(): Promise<{ dir: string; path: string; startsPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-thread-reader-'));
  const startsPath = join(dir, 'starts.txt');
  const scriptPath = join(dir, 'fake-app-server.mjs');
  const path = process.platform === 'win32' ? join(dir, 'codex.cmd') : scriptPath;
  const script = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(${JSON.stringify(startsPath)}, process.pid + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ id: request.id, result: { userAgent: 'fake' } });
    return;
  }
  if (request.method === 'thread/read') {
    const threadId = request.params.threadId;
    send({ id: request.id, result: { thread: {
      id: threadId,
      turns: [{ id: 'turn-' + threadId, status: 'completed', items: [] }]
    } } });
    return;
  }
  if (request.method === 'thread/list') {
    send({ id: request.id, result: { data: [{ id: 'thread-b', updatedAt: 12 }] } });
  }
});
`;
  await writeFile(scriptPath, script, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await chmod(path, 0o755);
  }
  return { dir, path, startsPath };
}
