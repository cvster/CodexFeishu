import { randomUUID } from 'node:crypto';
import type { NormalizedMessage } from '@larksuite/channel';
import type { Controls } from '../commands';
import { resolveModelArg } from '../agent/models';
import { codexBridgeClientMessageId } from '../session/codex-origin';
import { CodexSubmissionStore, type CodexSubmissionRecord } from '../session/codex-submissions';
import { RunRejected } from '../runtime/errors';
import { log } from '../core/logger';
import { prepareRunFlow, recordRunSessionEvent, type StartRunFlowInput } from './run-flow';
import type { CodexSubmissionResult } from '../../packages/codex-core/src/submission';

export async function submitFeishuCodex(input: StartRunFlowInput, batch: NormalizedMessage[],
  store: CodexSubmissionStore, controls: Controls, reply: { replyTo: string; replyInThread?: boolean }):
  Promise<CodexSubmissionResult | { status: 'rejected' | 'deferred'; message: string }> {
  const prepared = await prepareRunFlow(input);
  const incoming = store.records().filter(r => r.messages.some(m => batch.some(b => b.messageId === m.messageId)));
  if (!prepared.ok) {
    for (const r of incoming) if (r.status === 'pending') await store.mark(r.id, { status: 'rejected', error: prepared.rejectReason.userVisible });
    return { status: 'rejected', message: prepared.rejectReason.userVisible };
  }
  if (incoming.some(r => r.status !== 'pending')) throw new Error('Message is already submitted or requires reconciliation');
  const inheritedFreshBinding = incoming.every(r => r.expectedThreadId === undefined) && store.records().some(r =>
    r.scope === input.scopeId && r.expectedThreadId === undefined && r.threadId === prepared.threadId &&
    (r.status === 'accepted' || r.status === 'completed') && incoming.every(i => r.createdAtMs <= i.createdAtMs));
  if (incoming.some(r => r.expectedThreadId !== prepared.threadId) && !inheritedFreshBinding) {
    for (const r of incoming) await store.mark(r.id, { status: 'rejected', error: '会话绑定已改变，请重新发送。' });
    return { status: 'rejected', message: '会话绑定已改变，请重新发送。' };
  }
  const record: CodexSubmissionRecord = { id: randomUUID(), scope: input.scopeId, messages: batch,
    status: 'pending', createdAtMs: Math.min(Date.now(), ...incoming.map(r => r.createdAtMs)), updatedAtMs: Date.now(),
    expectedThreadId: prepared.threadId, threadId: prepared.threadId, prompt: prepared.policy.prompt,
    clientUserMessageId: '', ...reply };
  record.clientUserMessageId = codexBridgeClientMessageId(record.id);
  await store.prepare(record);
  const validate = () => {
    if (input.sessionCatalog?.isScopeArchived(input.scopeId) ||
      (prepared.threadId && input.sessionCatalog?.isThreadArchived(prepared.threadId))) throw new RunRejected('session-archived', '会话已归档。');
    const current = input.sessionCatalog?.activeFor({ scopeId: input.scopeId, agentId: 'codex',
      cwdRealpath: prepared.cwdRealpath, policyFingerprint: prepared.policy.policyFingerprint })?.threadId;
    if (current !== prepared.threadId) throw new Error('会话绑定已改变，请重新发送。');
  };
  let sendPermissionGranted = false;
  try {
    const result = await input.executor.submitMessage({ scopeId: input.scopeId, policy: prepared.policy,
      submissionId: record.id, threadId: prepared.threadId, validateBeforeStart: validate,
      beforeSpawn: async () => { if (await input.checkSessionArchived?.()) throw new RunRejected('session-archived', '会话已归档。'); },
      model: resolveModelArg('codex', input.profileConfig.preferences.model),
      reasoningEffort: input.profileConfig.preferences.reasoningEffort ?? 'high',
      images: prepared.policy.attachments.filter(a => a.kind === 'image' && a.decision === 'accepted' && a.path).map(a => a.path!),
      attachmentPaths: prepared.policy.attachments.filter(a => a.decision === 'accepted' && a.path).map(a => a.path!),
    }, async value => {
      validate();
      recordRunSessionEvent({ scopeId: input.scopeId, botAppId: input.profileConfig.accounts.app.id,
        sessions: input.sessions, sessionCatalog: input.sessionCatalog, capability: input.capability,
        policy: prepared.policy, event: { type: 'system', threadId: value.threadId } });
      await input.sessionCatalog?.flush();
      await store.mark(record.id, { threadId: value.threadId, knownTurnIds: value.knownTurnIds,
        transport: value.transport, status: 'sending' }, ['pending']);
      await controls.codexReplySync?.registerSubmission?.(store.records().find(r => r.id === record.id)!);
      if (input.sessionCatalog?.isScopeArchived(input.scopeId) || await input.checkSessionArchived?.()) throw new RunRejected('session-archived', '会话已归档。');
      const current = input.sessionCatalog?.activeFor({ scopeId: input.scopeId, agentId: 'codex',
        cwdRealpath: prepared.cwdRealpath, policyFingerprint: prepared.policy.policyFingerprint })?.threadId;
      if (current !== value.threadId) throw new Error('会话绑定已改变，请重新发送。');
      sendPermissionGranted = true;
    });
    const latest = store.records().find(r => r.id === record.id)!;
    if (latest.status === 'completed') return { status: 'accepted', submissionId: record.id,
      threadId: latest.threadId!, transport: latest.transport ?? result.transport,
      ...(result.status === 'accepted' ? { queueId: result.queueId } : {}) };
    await store.mark(record.id, result.status === 'accepted'
      ? { status: 'accepted', queueId: result.queueId,
        ...(result.clientUserMessageId ? { clientUserMessageId: result.clientUserMessageId } : {}) }
      : { status: result.status, error: result.message });
    void controls.codexReplySync?.runNow().catch(error => log.warn('submission', 'reply-sync-kick-failed', { message: String(error) }));
    return result;
  } catch (error) {
    const latest = store.records().find(r => r.id === record.id);
    if (!sendPermissionGranted && error instanceof RunRejected && error.code === 'reconnect-in-progress') {
      await store.mark(record.id, { status: 'pending', error: 'Waiting for bridge reconnect' });
      return { status: 'deferred', message: 'Waiting for bridge reconnect' };
    }
    const unknown = sendPermissionGranted || latest?.status === 'accepted' || latest?.status === 'completed';
    await store.mark(record.id, { status: unknown ? 'unknown' : 'rejected', error: String(error) }).catch(() => {});
    return { status: unknown ? 'unknown' : 'rejected', submissionId: record.id,
      threadId: latest?.threadId ?? prepared.threadId ?? '', transport: latest?.transport ?? 'cli',
      message: error instanceof Error ? error.message : String(error) };
  }
}
