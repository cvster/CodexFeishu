import type { CodexThreadReader } from '../session/codex-thread-reader';
import type { CodexSubmissionStore } from '../session/codex-submissions';

export async function stopCodexSubmissions(scope: string, threadId: string, store: CodexSubmissionStore,
  writer: Pick<CodexThreadReader, 'readThreadStatus' | 'readThread' | 'interruptTurn' | 'listQueuedSubmissions' | 'deleteQueuedTurn'>): Promise<boolean> {
  for (const r of store.records()) if (r.scope === scope && r.status === 'pending') {
    await store.mark(r.id, { status: 'cancelled' });
  }
  const status = await writer.readThreadStatus(threadId);
  if (status?.type === 'active') {
    const snapshot = await writer.readThread(threadId);
    const turn = [...snapshot.turns].reverse().find(t => t.status === 'inProgress');
    if (!turn) throw new Error('无法确认正在运行的轮次，请在桌面停止。');
    await writer.interruptTurn(threadId, turn.id);
    return true;
  }
  if (status?.type !== 'idle' && status?.type !== 'notLoaded') throw new Error('无法确认任务状态，请在桌面停止。');
  const queued = new Set((await writer.listQueuedSubmissions(threadId)).map(q => q.id));
  let stopped = false;
  for (const r of store.records()) {
    if (r.scope !== scope || r.threadId !== threadId || !r.queueId || !queued.has(r.queueId) ||
      (r.status !== 'accepted' && r.status !== 'unknown')) continue;
    await writer.deleteQueuedTurn(threadId, r.queueId);
    await store.mark(r.id, { status: 'cancelled' }); stopped = true;
  }
  return stopped;
}
