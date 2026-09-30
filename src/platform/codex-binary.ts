import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { spawnProcess } from './spawn';

export interface CodexBinaryEnvironment {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** Resolve again for each spawn: Desktop updates remove versioned CLI directories. */
export function resolveCodexBinary(
  configured: string,
  options: CodexBinaryEnvironment = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const canonical = /^codex(?:\.exe|\.cmd|\.bat)?$/i.test(basename(configured));
  if (!canonical) return configured; // Preserve explicit custom/test executables.

  const desktopRoot = desktopBinRoot(configured);
  if (desktopRoot) {
    const newest = latestExecutable(desktopRoot, (dir) => join(dir, 'codex.exe'));
    if (newest) return newest;
  }
  if (isAbsolute(configured) && executable(configured)) return configured;

  // Prefer the Desktop binary for a stale Desktop path; do not silently
  // downgrade it to an older npm shim found earlier on PATH.
  if (platform === 'win32' && desktopRoot) {
    const appRoot = join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    const newest = latestExecutable(appRoot, (dir) => join(dir, 'codex.exe'));
    if (newest) return newest;
  }
  const envPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex'] : ['codex'];
  for (const dir of envPath.split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (executable(candidate)) return candidate;
    }
  }
  if (platform === 'win32') {
    const appRoot = join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    const newest = latestExecutable(appRoot, (dir) => join(dir, 'codex.exe'));
    if (newest) return newest;
  }
  // Services can keep an old NVM PATH after Node is upgraded.
  if (platform !== 'win32') {
    const nvmRoot = join(env.NVM_DIR ?? join(home, '.nvm'), 'versions', 'node');
    const newest = latestExecutable(nvmRoot, (dir) => join(dir, 'bin', 'codex'));
    if (newest) return newest;
    for (const dir of [join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin']) {
      const candidate = join(dir, 'codex');
      if (executable(candidate)) return candidate;
    }
  }
  return configured; // Keep the existing preflight diagnostic when nothing is installed.
}

export function spawnCodexProcess(command: string, args: readonly string[] = [], options: SpawnOptions = {}) {
  return spawnProcess(resolveCodexBinary(command, { env: options.env }), args, options);
}

function desktopBinRoot(path: string): string | undefined {
  return /[/\\]OpenAI[/\\]Codex[/\\]bin[/\\][^/\\]+[/\\]codex\.exe$/i.test(path)
    ? dirname(dirname(path))
    : undefined;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function latestExecutable(root: string, binaryForDir: (dir: string) => string): string | undefined {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => binaryForDir(join(root, entry.name)))
      .filter(executable)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}
