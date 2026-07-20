function normalizeOriginator(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function inferCodexSessionOrigin(
  sessionData,
  storedOrigin = null,
  hasBackendFallbackOrigin = false,
) {
  if (hasBackendFallbackOrigin) {
    return 'backend';
  }

  const originator = normalizeOriginator(sessionData?.originator);
  const isDesktopSource = sessionData?.source === 'vscode';

  // The rollout originator is the authoritative signal. In particular, SDK-created
  // sessions may also use the vscode source, so a stale local "app" marker must not
  // make them appear in the Codex App list.
  if (originator) {
    return isDesktopSource && originator === 'codex desktop' ? 'app' : 'backend';
  }

  if (storedOrigin === 'app' || storedOrigin === 'backend') {
    return storedOrigin;
  }

  // Compatibility for older Codex Desktop rollouts that predate originator metadata.
  return isDesktopSource ? 'app' : 'backend';
}

function sessionTimestamp(session) {
  const timestamp = new Date(session?.lastActivity || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function selectNewCodexAppSession(sessions, previousSessionIds) {
  const previousIds = new Set(previousSessionIds || []);
  return (sessions || [])
    .filter((session) =>
      typeof session?.id === 'string' &&
      session.sessionOrigin === 'app' &&
      !previousIds.has(session.id)
    )
    .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left))[0] || null;
}
