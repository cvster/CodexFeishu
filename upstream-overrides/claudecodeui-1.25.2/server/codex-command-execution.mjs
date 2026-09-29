export function executeCodexCommand({ command, options, writer }, dependencies) {
  const { enqueueCodexCliMessage } = dependencies;
  let createdSessionId = options.sessionId || null;

  writer.send({
    type: 'codex-cli-command-submitted',
    sessionId: createdSessionId,
    provider: 'codex',
  });

  const completion = Promise.resolve(enqueueCodexCliMessage({
    sessionId: createdSessionId,
    projectPath: options.projectPath || options.cwd,
    message: command || '',
    newSession: Boolean(options.newSession || !createdSessionId),
    model: options.model,
    modelReasoningEffort: options.modelReasoningEffort,
    onSessionCreated: (sessionId) => {
      createdSessionId = sessionId;
      writer.setSessionId(sessionId);
      writer.send({ type: 'session-created', sessionId, provider: 'codex' });
    },
  })).then((result) => {
    if (result?.error || result?.skipped) {
      writer.send({
        type: 'codex-cli-command-error',
        sessionId: createdSessionId,
        error: result?.error || 'Failed to submit the message through Codex CLI.',
        provider: 'codex',
      });
      return result;
    }

    const sessionId = result?.sessionId || createdSessionId;
    if (sessionId && !createdSessionId) {
      writer.setSessionId(sessionId);
      writer.send({ type: 'session-created', sessionId, provider: 'codex' });
    }
    writer.send({ type: 'codex-cli-command-delivered', sessionId, provider: 'codex' });
    return result;
  });

  return { mode: 'cli', completion };
}

export async function executeCodexArchive(
  { sessionId, provider, projectPath },
  dependencies,
) {
  const { archiveSession, archiveCodexAppThread, broadcastProjectsUpdated } = dependencies;

  if (provider === 'codex') {
    const archiveResult = await archiveCodexAppThread({ sessionId, projectPath });
    if (archiveResult?.skipped) {
      return {
        success: false,
        status: 409,
        error: archiveResult.error || 'Codex CLI archive was not completed',
        reason: archiveResult.reason,
      };
    }
  }

  archiveSession(sessionId, provider);
  await broadcastProjectsUpdated({ changeType: 'session_archived', provider, sessionId });
  return { success: true };
}
