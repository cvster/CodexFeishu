import type { CodexThreadReader } from './thread-client';

export interface CodexSubmissionInput {
  submissionId: string;
  clientUserMessageId: string;
  threadId: string;
  prompt: string;
  images?: readonly string[];
}
export interface QueuedCodexSubmission {
  id: string;
  clientUserMessageId?: string;
  input: unknown[];
}
type SubmissionIdentity = { submissionId: string; threadId: string; transport: 'rpc' | 'cli' };
export type CodexSubmissionResult = SubmissionIdentity & (
  | { status: 'accepted'; queueId?: string; clientUserMessageId?: string; continuationWarning?: string }
  | { status: 'rejected' | 'unknown'; message: string }
);
export interface CodexSubmissionTransport {
  shared?: Pick<CodexThreadReader, 'connect' | 'listQueuedSubmissions' | 'addQueuedSubmission'> &
    Partial<Pick<CodexThreadReader, 'continueQueuedAfterInterruption'>>;
  runCli(input: CodexSubmissionInput): Promise<{ code: number | null; stdout: string; stderr: string }>;
  beforeSend(transport: 'rpc' | 'cli'): Promise<void>;
  timeoutMs?: number;
}

/** An acceptance boundary, never an execution/turn observer. No write retries. */
export async function submitCodexInput(input: CodexSubmissionInput,
  deps: CodexSubmissionTransport): Promise<CodexSubmissionResult> {
  if (!input.threadId.trim() || !input.prompt.trim() || !input.clientUserMessageId) {
    throw new Error('Submission thread, input and client message ID are required');
  }
  const timeout = deps.timeoutMs ?? 30_000;
  let useRpc = false;
  if (deps.shared) {
    // Read-only capability detection before *any* potentially accepted write.
    try {
      await bounded(deps.shared.connect(), timeout);
      await bounded(deps.shared.listQueuedSubmissions(input.threadId), timeout);
      useRpc = true;
    } catch { /* CLI is safe here: no input has been sent. */ }
  }
  const transport = useRpc ? 'rpc' : 'cli';
  const identity = { submissionId: input.submissionId, threadId: input.threadId, transport } as const;
  await deps.beforeSend(transport);
  try {
    if (useRpc) {
      const queued = await bounded(deps.shared!.addQueuedSubmission(input), timeout);
      let continuationWarning: string | undefined;
      try { await bounded(deps.shared!.continueQueuedAfterInterruption?.(input.threadId) ?? Promise.resolve(), timeout); }
      catch (error) {
        // Acceptance is already confirmed. Never downgrade it to unknown or
        // send the input again just because the queue wake-up was unconfirmed.
        continuationWarning = error instanceof Error ? error.message : String(error);
      }
      return { ...identity, status: 'accepted', queueId: queued.id,
        ...(continuationWarning ? { continuationWarning } : {}),
        ...(queued.clientUserMessageId ? { clientUserMessageId: queued.clientUserMessageId } : {}) };
    }
    const result = await bounded(deps.runCli(input), timeout);
    const match = /Queued message\s+([^\s.]+)\s+for thread/i.exec(result.stdout);
    if (result.code === 0 && match?.[1]) return { ...identity, status: 'accepted', queueId: match[1] };
    // A lost stdout/transport response is not proof that the message was rejected.
    return { ...identity, status: 'unknown',
      message: result.stderr.trim() || result.stdout.trim() || `CLI exited ${result.code} without queue acknowledgement` };
  } catch (error) {
    return { ...identity, status: error instanceof Error && error.name === 'CodexRpcError' ? 'rejected' : 'unknown',
      message: error instanceof Error ? error.message : String(error) };
  }
}

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Codex submission acknowledgement timed out')), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
