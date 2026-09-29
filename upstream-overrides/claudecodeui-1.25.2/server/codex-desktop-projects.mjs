import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function extractCodexDesktopWorkspaceRoots(state) {
  const workspaceRoots = [];
  const seenWorkspaceRoots = new Set();
  const localProjects =
    state?.['local-projects'] &&
    typeof state['local-projects'] === 'object' &&
    !Array.isArray(state['local-projects'])
      ? state['local-projects']
      : {};
  const projectOrder = Array.isArray(state?.['project-order'])
    ? state['project-order']
    : [];

  const addWorkspaceRoot = (workspaceRoot) => {
    if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
      return;
    }

    const normalizedWorkspaceRoot = path.resolve(workspaceRoot).toLowerCase();
    if (seenWorkspaceRoots.has(normalizedWorkspaceRoot)) {
      return;
    }

    seenWorkspaceRoots.add(normalizedWorkspaceRoot);
    workspaceRoots.push(workspaceRoot);
  };

  // project-order is the desktop App sidebar's authoritative membership and
  // order. IDs without local-project records are remote projects and cannot be
  // opened by this local web service, so they are intentionally skipped.
  for (const projectEntry of projectOrder) {
    const project =
      typeof projectEntry === 'string' &&
      localProjects[projectEntry] &&
      typeof localProjects[projectEntry] === 'object'
        ? localProjects[projectEntry]
        : null;

    if (project && Array.isArray(project.rootPaths)) {
      project.rootPaths.forEach(addWorkspaceRoot);
      continue;
    }

    // Older App builds wrote absolute paths directly into project-order.
    addWorkspaceRoot(projectEntry);
  }

  if (projectOrder.length > 0) {
    return workspaceRoots;
  }

  // Compatibility fallback for older/transitional App builds which do not
  // have project-order. These keys are history, not authoritative membership,
  // and must never augment a current project-order list.
  for (const key of ['electron-saved-workspace-roots', 'active-workspace-roots']) {
    const roots = state?.[key];
    if (Array.isArray(roots)) {
      roots.forEach(addWorkspaceRoot);
    }
  }

  Object.values(localProjects).forEach((project) => {
    if (project && Array.isArray(project.rootPaths)) {
      project.rootPaths.forEach(addWorkspaceRoot);
    }
  });

  return workspaceRoots;
}

export function findCodexAppProjectId(state, workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
    return null;
  }

  const normalizedRoot = path.resolve(workspaceRoot).toLowerCase();
  const localProjects =
    state?.['local-projects'] && typeof state['local-projects'] === 'object'
      ? state['local-projects']
      : {};
  const legacyProjectId = Object.entries(localProjects).find(([, project]) => (
    Array.isArray(project?.rootPaths) &&
    project.rootPaths.some((root) => (
      typeof root === 'string' && path.resolve(root).toLowerCase() === normalizedRoot
    ))
  ))?.[0];

  if (!legacyProjectId) {
    return null;
  }

  const mappings = state?.['app-server-project-id-by-legacy-project-id-by-host'];
  for (const hostMappings of Object.values(mappings || {})) {
    const projectId = hostMappings?.[legacyProjectId];
    if (typeof projectId === 'string' && projectId.trim()) {
      return projectId.trim();
    }
  }

  return null;
}

export async function resolveCodexAppProjectId(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.startsWith('codex://')) {
    return null;
  }

  const statePath = path.join(os.homedir(), '.codex', '.codex-global-state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  return findCodexAppProjectId(state, workspaceRoot);
}
