import { chmod, mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodexBinary } from '../../../src/platform/codex-binary';

describe('Codex binary updates', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('discovers the new Desktop binary after the old version directory is removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-update-'));
    roots.push(root);
    const bin = join(root, 'OpenAI', 'Codex', 'bin');
    const old = join(bin, 'old-build', 'codex.exe');
    const current = join(bin, 'current-build', 'codex.exe');
    await executable(old);
    expect(resolveCodexBinary(old, { env: {} })).toBe(old);
    await executable(current);
    await utimes(current, new Date(), new Date(Date.now() + 10_000));
    expect(resolveCodexBinary(old, { env: {} })).toBe(current);
    await unlink(old);
    expect(resolveCodexBinary(old, { env: {} })).toBe(current);
  });

  it('recovers a stale canonical path through PATH but preserves a custom executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-path-'));
    roots.push(root);
    const current = join(root, 'codex');
    await executable(current);
    const options = { platform: 'linux' as const, env: { PATH: root }, homeDir: root };
    expect(resolveCodexBinary(join(root, 'removed', 'codex'), options)).toBe(current);
    const custom = join(root, 'missing-custom-agent');
    expect(resolveCodexBinary(custom, options)).toBe(custom);
  });

  it('finds a new NVM installation when the service inherited an outdated PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-nvm-'));
    roots.push(root);
    const current = join(root, '.nvm', 'versions', 'node', 'v24.20.0', 'bin', 'codex');
    await executable(current);
    expect(resolveCodexBinary(join(root, '.nvm', 'versions', 'node', 'v22.0.0', 'bin', 'codex'), {
      platform: 'linux', env: { PATH: '/missing' }, homeDir: root,
    })).toBe(current);
  });
});

async function executable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
}
