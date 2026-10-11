import type { CodexThreadReader } from '../session/codex-thread-reader';
import type { CodexSubmissionStore } from '../session/codex-submissions';

export class CodexQueueContinuationError extends Error {
  override name = 'CodexQueueContinuationError';
  constructor(cause: unknown) {
    super(`当前响应已停止，但后续队列继续执行未确认：${cause instanceof Error ? cause.message : String(cause)}。请在 Codex 桌面检查队列。`, { cause });
  }
}

/** Stop only the active turn. Never resume the thread or discard later input. */
export async function stopCodexSubmissions(threadId: string,
  writer: Pick<CodexThreadReader, 'readThreadStatus' | 'readThread' | 'interruptTurn' | 'listQueuedSubmissions' | 'startQueuedTurn'>,
  waitForIntake?: () => Promise<void>): Promise<boolean> {
  const status = await writer.readThreadStatus(threadId);
  if (status?.type === 'active') {
    const snapshot = await writer.readThread(threadId);
    const turn = [...snapshot.turns].reverse().find(t => t.status === 'inProgress');
    if (!turn) throw new Error('无法确认正在运行的轮次，请在桌面停止。');
    await writer.interruptTurn(threadId, turn.id);
    try {
      // The interrupt acknowledgement precedes queue/start. Intake must also
      // settle, otherwise a message still in debounce could miss this wake-up.
      await waitForIntake?.();
      // A newly accepted message (or Desktop) may have already woken the queue.
      if ((await writer.readThreadStatus(threadId))?.type === 'active') return true;
      const [next] = await writer.listQueuedSubmissions(threadId);
      if (next) await writer.startQueuedTurn(threadId, next.id);
    } catch (error) { throw new CodexQueueContinuationError(error); }
    return true;
  }
  if (status?.type !== 'idle' && status?.type !== 'notLoaded') throw new Error('无法确认任务状态，请在桌面停止。');
  return false;
}

/** Read-only, bounded wait for already-received input; never retries a write. */
export async function waitForCodexIntake(scope: string, store: CodexSubmissionStore, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (store.records().some(r => r.scope === scope && (r.status === 'pending' || r.status === 'sending'))) {
    if (Date.now() >= deadline) throw new Error('后续消息仍在提交，请稍后在桌面继续队列');
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
}
