import { copyFile, mkdtemp, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CodexThreadReader } from '../../src/session/codex-thread-reader';

describe('installed Codex idle materialization (no model/API call)', () => {
  it.skipIf(!process.env.CODEX_IDLE_TEST_BINARY)('persists empty history for another writer to read after creator exit', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-idle-offline-'));
    await copyFile(new URL('../fixtures/codex/idle-offline.toml', import.meta.url), join(home, 'config.toml'));
    const options = { binary: process.env.CODEX_IDLE_TEST_BINARY!, codexHome: home,
      inheritCodexHome: false, profileStateDir: home, timeoutMs: 30_000 };
    const creator = new CodexThreadReader(options);
    const reader = new CodexThreadReader(options);
    try {
      const id = await creator.createIdleThread({ cwd: home, sandbox: 'read-only', model: 'offline-fixture' });
      const snapshot = await creator.readThread(id);
      expect(snapshot.turns).toEqual([]); expect(snapshot.rolloutPath).toBeTruthy();
      await access(snapshot.rolloutPath!);
      await creator.stop();
      expect((await reader.readThread(id)).turns).toEqual([]);
    } finally {
      await creator.stop(); await reader.stop();
      await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 60_000);
});
