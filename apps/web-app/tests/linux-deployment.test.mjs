import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Linux 部署保持后端回环监听并只发布指定私网地址', async () => {
  const [installer, service, nginx] = await Promise.all([
    readFile(new URL('../scripts/install-mobile-codex-linux.sh', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/mobile-codex-helper.service.in', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/nginx-mobile-codex-linux.conf.in', import.meta.url), 'utf8'),
  ]);

  assert.match(installer, /\/home\/pc\/software\/mobileCodexHelper/);
  assert.match(installer, /systemctl --user enable --now/);
  assert.match(installer, /sudo -n nginx -t/);
  assert.match(service, /Environment="HOST=127\.0\.0\.1"/);
  assert.match(service, /Environment="PORT=3001"/);
  assert.match(service, /Restart=always/);
  assert.match(nginx, /listen 127\.0\.0\.1:8080;/);
  assert.match(nginx, /listen __PRIVATE_IP__:8080;/);
  assert.doesNotMatch(nginx, /listen 0\.0\.0\.0/);
});
