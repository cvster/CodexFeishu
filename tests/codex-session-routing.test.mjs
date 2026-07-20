import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inferCodexSessionOrigin,
  selectNewCodexAppSession,
} from '../upstream-overrides/claudecodeui-1.25.2/server/codex-session-routing.mjs';

test('SDK 会话不会因旧的 app 标记混入 App 列表', () => {
  assert.equal(inferCodexSessionOrigin({
    source: 'vscode',
    originator: 'codex_sdk_ts',
  }, 'app'), 'backend');
});

test('只正向识别 Codex Desktop 创建的 App 会话', () => {
  assert.equal(inferCodexSessionOrigin({
    source: 'vscode',
    originator: 'Codex Desktop',
  }, 'backend'), 'app');
  assert.equal(inferCodexSessionOrigin({
    source: 'exec',
    originator: 'Codex Desktop',
  }), 'backend');
});

test('新建会话只回填新出现的 App 会话 ID', () => {
  const selected = selectNewCodexAppSession([
    { id: 'sdk-new', sessionOrigin: 'backend', lastActivity: '2026-07-20T03:00:02Z' },
    { id: 'app-old', sessionOrigin: 'app', lastActivity: '2026-07-20T03:00:01Z' },
    { id: 'app-new', sessionOrigin: 'app', lastActivity: '2026-07-20T03:00:00Z' },
  ], ['app-old']);

  assert.equal(selected?.id, 'app-new');
});

test('没有新 App 会话时不误报成功', () => {
  const selected = selectNewCodexAppSession([
    { id: 'sdk-new', sessionOrigin: 'backend', lastActivity: '2026-07-20T03:00:02Z' },
    { id: 'app-old', sessionOrigin: 'app', lastActivity: '2026-07-20T03:00:01Z' },
  ], ['app-old']);

  assert.equal(selected, null);
});
