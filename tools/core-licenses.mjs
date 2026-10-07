import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const out = resolve('packages/codex-core/dist/licenses');
await mkdir(out, { recursive: true });
for (const name of ['cross-spawn', 'ws', 'path-key', 'shebang-command', 'shebang-regex', 'which', 'isexe']) {
  const dir = dirname(require.resolve(`${name}/package.json`, { paths: [dirname(require.resolve('cross-spawn/package.json'))] }));
  let copied = false;
  for (const file of ['LICENSE', 'LICENSE.md', 'license']) {
    try { await copyFile(join(dir, file), join(out, `${name}.txt`)); copied = true; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!copied) throw new Error(`Bundled license missing: ${name}`);
}
