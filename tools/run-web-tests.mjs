import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const directory = resolve('apps/web-app/tests');
const files = (await readdir(directory)).filter((name) => name.endsWith('.test.mjs') && !name.endsWith('.live.test.mjs'));
const result = spawnSync(process.execPath, ['--test', ...files.map((name) => resolve(directory, name))], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
