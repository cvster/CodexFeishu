export function executeCodexCommand({ command, options, desktopSyncContext, writer }, dependencies) {
  const {
    enqueueCodexDesktopMessageBridge,
    queryCodex,
    setSessionOrigin,
  } = dependencies;

  const shouldBridgeToDesktopUI =
    options.executionMode === 'desktop-ui' ||
    (desktopSyncContext?.isMobile && options.executionMode !== 'sdk');

  if (!shouldBridgeToDesktopUI) {
    return {
      mode: 'backend',
      completion: Promise.resolve(
        queryCodex(command, {
          ...options,
          sessionOrigin: 'backend',
          syncToDesktop: false,
          desktopSync: null,
        }, writer),
      ),
    };
  }

  const projectPath = options.projectPath || options.cwd;
  const sourceContext = { ...(desktopSyncContext || {}), isMobile: true };

  writer.send({
    type: 'codex-desktop-command-submitted',
    sessionId: options.sessionId || null,
    provider: 'codex',
  });

  const completion = Promise.resolve(enqueueCodexDesktopMessageBridge({
    sessionId: options.sessionId || null,
    projectPath,
    message: command || '',
    newSession: Boolean(options.newSession),
    sessionTitleHint: options.sessionTitleHint || null,
    sourceContext,
  })).then((bridgeResult) => {
    if (bridgeResult?.error || bridgeResult?.skipped) {
      writer.send({
        type: 'codex-desktop-command-error',
        sessionId: options.sessionId || null,
        error: bridgeResult?.error || 'Failed to submit the message to the desktop Codex app.',
        provider: 'codex',
      });
      return bridgeResult;
    }

    const bridgedSessionId = bridgeResult?.sessionId || options.sessionId || null;
    if (bridgedSessionId) {
      if (bridgeResult?.sessionId && !options.sessionId) {
        writer.setSessionId(bridgedSessionId);
        writer.send({
          type: 'session-created',
          sessionId: bridgedSessionId,
          provider: 'codex',
        });
      }

      setSessionOrigin(bridgedSessionId, 'codex', 'app');
    }

    writer.send({
      type: 'codex-desktop-command-delivered',
      sessionId: bridgedSessionId,
      provider: 'codex',
    });
    return bridgeResult;
  });

  return { mode: 'app', completion };
}

export async function executeCodexArchive(
  { sessionId, provider, projectPath, sessionTitle, sourceContext },
  dependencies,
) {
  const {
    archiveSession,
    broadcastProjectsUpdated,
    enqueueCodexDesktopArchive,
    getCodexSessions,
    getSessionOrigin,
  } = dependencies;

  let sessionOrigin = null;
  if (provider === 'codex') {
    const indexedSessions = projectPath
      ? await getCodexSessions(projectPath, { limit: 0 })
      : [];
    const indexedSession = indexedSessions.find((session) => session.id === sessionId);
    sessionOrigin = indexedSession?.sessionOrigin || getSessionOrigin(sessionId, provider) || 'backend';
  }

  if (provider === 'codex' && sessionOrigin === 'app') {
    const archiveResult = await enqueueCodexDesktopArchive({
      sessionId,
      projectPath,
      sessionTitleHint: sessionTitle || null,
      sourceContext,
    });

    if (archiveResult?.skipped) {
      return {
        success: false,
        status: 409,
        error: archiveResult.error || 'Codex desktop archive was not completed',
        reason: archiveResult.reason,
        target: archiveResult.target || null,
      };
    }
  }

  archiveSession(sessionId, provider);
  await broadcastProjectsUpdated({
    changeType: 'session_archived',
    provider,
    sessionId,
  });

  return { success: true, sessionOrigin };
}
