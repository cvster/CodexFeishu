export interface PersistedThreadOptions {
  cwd: string;
  sandbox: string;
  model?: string;
  reasoningEffort?: string;
  developerInstructions?: string;
  projectId?: string;
  threadSource?: string;
  name?: string;
}

/** Materialize metadata, validate history, then release the creator before queue. */
export async function createPersistedCodexThread(
  client: { request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> },
  options: PersistedThreadOptions,
): Promise<string> {
  const result = await client.request('thread/start', {
    cwd: options.cwd, approvalPolicy: 'never', sandbox: options.sandbox,
    historyMode: 'legacy', threadSource: options.threadSource ?? 'lark-channel-bridge',
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
    config: { shell_environment_policy: { inherit: 'all' },
      ...(options.reasoningEffort ? { model_reasoning_effort: options.reasoningEffort } : {}) },
  });
  const thread = result.thread as Record<string, unknown> | undefined;
  if (!thread || typeof thread.id !== 'string' || !thread.id) throw new Error('thread/start returned no thread id');
  await client.request('thread/name/set', { threadId: thread.id, name: options.name ?? 'Codex会话' });
  const checked = await client.request('thread/read', { threadId: thread.id, includeTurns: true });
  const persisted = checked.thread as Record<string, unknown> | undefined;
  if (persisted?.id !== thread.id || !Array.isArray(persisted.turns)) {
    throw new Error('thread/read returned malformed persisted history');
  }
  return thread.id;
}
