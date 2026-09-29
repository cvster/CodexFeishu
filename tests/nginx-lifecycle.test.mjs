import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('nginx 由独立计划任务以前台模式常驻', async () => {
  const [nginxStart, stackStart, stackStop] = await Promise.all([
    readFile(new URL('../scripts/start-mobile-codex-nginx.ps1', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/start-mobile-codex-stack.ps1', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/stop-mobile-codex-stack.ps1', import.meta.url), 'utf8'),
  ]);

  assert.match(nginxStart, /\[switch\]\$Foreground/);
  assert.match(nginxStart, /daemon off;/);
  assert.match(stackStart, /MobileCodexHelper-Nginx/);
  assert.match(stackStart, /-Foreground/);
  assert.match(stackStart, /RestartCount 999/);
  assert.match(stackStop, /Unregister-ScheduledTask -TaskName \$nginxTaskName/);
});
