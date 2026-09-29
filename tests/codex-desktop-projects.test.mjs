import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractCodexDesktopWorkspaceRoots,
  findCodexAppProjectId,
} from '../upstream-overrides/claudecodeui-1.25.2/server/codex-desktop-projects.mjs';

test('以 App project-order 为项目成员和顺序的唯一来源', () => {
  const roots = extractCodexDesktopWorkspaceRoots({
    'project-order': ['remote-project', 'local-a', 'local-b', 'local-a-duplicate'],
    'local-projects': {
      'local-a': { rootPaths: ['D:\\work\\alpha'] },
      'local-b': { rootPaths: ['D:\\work\\beta', 'D:\\work\\shared'] },
      'local-a-duplicate': { rootPaths: ['D:\\work\\alpha'] },
      removed: { rootPaths: ['D:\\work\\removed'] },
    },
    'electron-saved-workspace-roots': ['D:\\work\\stale'],
    'active-workspace-roots': ['D:\\work\\active-but-not-saved'],
  });

  assert.deepEqual(roots, [
    'D:\\work\\alpha',
    'D:\\work\\beta',
    'D:\\work\\shared',
  ]);
});

test('按工作目录解析 app-server 项目 ID', () => {
  const projectId = findCodexAppProjectId({
    'local-projects': {
      'local-a': { rootPaths: ['D:\\work\\alpha'] },
    },
    'app-server-project-id-by-legacy-project-id-by-host': {
      local: { 'local-a': 'app-project-a' },
    },
  }, 'D:\\work\\alpha');
  assert.equal(projectId, 'app-project-a');
});

test('旧版 App 没有 project-order 时才读取兼容字段', () => {
  const roots = extractCodexDesktopWorkspaceRoots({
    'local-projects': {
      local: { rootPaths: ['D:\\work\\local'] },
    },
    'electron-saved-workspace-roots': ['D:\\work\\saved'],
    'active-workspace-roots': ['D:\\work\\active'],
  });

  assert.deepEqual(roots, [
    'D:\\work\\saved',
    'D:\\work\\active',
    'D:\\work\\local',
  ]);
});
