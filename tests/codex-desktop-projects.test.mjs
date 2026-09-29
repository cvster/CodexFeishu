import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  extractCodexDesktopWorkspaceRoots,
  findCodexAppProjectId,
} from '../upstream-overrides/claudecodeui-1.25.2/server/codex-desktop-projects.mjs';

const workspacePath = (...segments) => path.resolve(path.parse(process.cwd()).root, 'work', ...segments);

test('以 App project-order 为项目成员和顺序的唯一来源', () => {
  const roots = extractCodexDesktopWorkspaceRoots({
    'project-order': ['remote-project', 'local-a', 'local-b', 'local-a-duplicate'],
    'local-projects': {
      'local-a': { rootPaths: [workspacePath('alpha')] },
      'local-b': { rootPaths: [workspacePath('beta'), workspacePath('shared')] },
      'local-a-duplicate': { rootPaths: [workspacePath('alpha')] },
      removed: { rootPaths: [workspacePath('removed')] },
    },
    'electron-saved-workspace-roots': [workspacePath('stale')],
    'active-workspace-roots': [workspacePath('active-but-not-saved')],
  });

  assert.deepEqual(roots, [
    workspacePath('alpha'),
    workspacePath('beta'),
    workspacePath('shared'),
  ]);
});

test('按工作目录解析 app-server 项目 ID', () => {
  const projectId = findCodexAppProjectId({
    'local-projects': {
      'local-a': { rootPaths: [workspacePath('alpha')] },
    },
    'app-server-project-id-by-legacy-project-id-by-host': {
      local: { 'local-a': 'app-project-a' },
    },
  }, workspacePath('alpha'));
  assert.equal(projectId, 'app-project-a');
});

test('旧版 App 没有 project-order 时才读取兼容字段', () => {
  const roots = extractCodexDesktopWorkspaceRoots({
    'local-projects': {
      local: { rootPaths: [workspacePath('local')] },
    },
    'electron-saved-workspace-roots': [workspacePath('saved')],
    'active-workspace-roots': [workspacePath('active')],
  });

  assert.deepEqual(roots, [
    workspacePath('saved'),
    workspacePath('active'),
    workspacePath('local'),
  ]);
});
