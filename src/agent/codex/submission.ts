import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexSubmissionResult } from '../../../packages/codex-core/src/submission';
import { submitCodexInput } from '../../../packages/codex-core/src/submission';
import { resolveSharedCodexEndpoint, buildNativeQueueArgs } from '../../../packages/codex-core/src/queue';
import { CodexThreadReader } from '../../session/codex-thread-reader';
import { codexBridgeClientMessageId } from '../../session/codex-origin';
import { spawnCodexProcess } from '../../platform/codex-binary';
import { mergeProcessEnv } from '../../platform/spawn';
import type { AgentRunOptions } from '../types';
import { log } from '../../core/logger';

export interface CodexSubmitOptions extends AgentRunOptions {
  binary: string; profileStateDir: string; codexHome?: string; inheritCodexHome: boolean;
  remote?: string; env?: NodeJS.ProcessEnv; developerInstructions?: string;
}
export async function submitCodexMessage(options: CodexSubmitOptions,
  beforeSend: (prepared: { threadId: string; knownTurnIds: string[]; transport: 'rpc' | 'cli' }) => Promise<void>):
  Promise<CodexSubmissionResult> {
  if (!options.cwd) throw new Error('cwd is required for Codex submission');
  for (const path of options.images ?? []) await access(path);
  const home = options.codexHome ?? options.env?.CODEX_HOME ?? process.env.CODEX_HOME ??
    (options.inheritCodexHome ? join(homedir(), '.codex') : join(options.profileStateDir, 'codex-home'));
  const env = mergeProcessEnv(process.env, { ...(options.env ?? {}), CODEX_HOME: home });
  const base = { binary: options.binary, profileStateDir: options.profileStateDir,
    codexHome: home, inheritCodexHome: options.inheritCodexHome, env };
  const history = new CodexThreadReader(base);
  const remote = await resolveSharedCodexEndpoint({ remote: options.remote ?? env.CODEX_QUEUE_REMOTE, codexHome: home });
  const shared = remote ? new CodexThreadReader({ ...base, sharedServer: true, passive: true, remote }) : undefined;
  try {
    const threadId = options.threadId ?? await history.createIdleThread({ ...options, cwd: options.cwd, sandbox: options.sandbox ?? 'danger-full-access' });
    const snapshot = await history.readThread(threadId);
    let connected = false;
    if (shared) {
      try { await shared.connect(); connected = true; }
      catch (error) { log.warn('agent', 'submission-shared-unavailable', { message: String(error) }); }
    }
    if ((options.model || options.reasoningEffort) && connected) {
      await shared!.updateThreadSettings(threadId, { model: options.model, reasoningEffort: options.reasoningEffort });
    } else if (options.model || options.reasoningEffort) {
      log.warn('agent', 'queue-settings-unavailable', { threadId,
        message: 'No public shared endpoint; queued input uses writer settings' });
    }
    const result = await submitCodexInput({ submissionId: options.runId, threadId, prompt: options.prompt,
      clientUserMessageId: codexBridgeClientMessageId(options.runId), images: options.images }, {
      shared: connected ? shared : undefined,
      beforeSend: transport => beforeSend({ threadId, knownTurnIds: snapshot.turns.map(t => t.id), transport }),
      runCli: input => new Promise((resolve, reject) => {
        const child = spawnCodexProcess(options.binary, buildNativeQueueArgs({ ...input, remote }),
          { cwd: options.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: Buffer[] = []; const stderr: Buffer[] = [];
        child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.once('error', reject);
        child.once('exit', code => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8') }));
      }),
    });
    log.info('agent', `submission-${result.status}`, { threadId, submissionId: options.runId,
      transport: result.transport, ...(result.status === 'accepted' ? { queueMessageId: result.queueId } : { message: result.message }) });
    return result;
  } finally { await Promise.all([history.stop(), shared?.stop()]); }
}
