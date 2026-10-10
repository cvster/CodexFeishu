import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { prepareRunFlow } from '../../../src/bot/run-flow';
import { codexCapability } from '../../../src/agent/capability';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { CodexSubmissionStore } from '../../../src/session/codex-submissions';
import { submitFeishuCodex } from '../../../src/bot/codex-submission-flow';

describe('Codex prepared submission policy', () => {
  it('uses the existing binding without starting a legacy execution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-prepare-'));
    try {
      const config = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex', inheritCodexHome: true },
        accounts: { app: { id: 'test', secret: 'test', tenant: 'feishu' } } });
      config.workspaces.default = dir;
      const catalog = new SessionCatalog(join(dir, 'catalog.json'));
      const input: any = { scopeId: 'oc_group', scope: { source: 'im', chatId: 'oc_group', actorId: 'user' },
        prompt: 'git状态', attachments: [], access: { ok: true, reason: 'allowed-user' }, capability: codexCapability(config),
        profileConfig: config, sessions: new SessionStore(join(dir, 'sessions.json')), sessionCatalog: catalog,
        workspaces: new WorkspaceStore(join(dir, 'workspaces.json')), executor: { submit: () => { throw new Error('old flow'); } }, now: 1000 };
      const initial = await prepareRunFlow(input); if (!initial.ok) throw new Error('Expected workspace');
      catalog.upsertActive({ scopeId: 'oc_group', agentId: 'codex', cwdRealpath: initial.cwdRealpath, policyFingerprint: initial.policy.policyFingerprint, threadId: 't1' });
      const result = await prepareRunFlow(input); expect(result).toMatchObject({ ok: true, threadId: 't1', policy: { prompt: 'git状态' } });
      const store = new CodexSubmissionStore(join(dir, 'outbox.json')); await store.load();
      const m = { messageId: 'm1', chatId: 'oc_group', content: 'git状态' } as any;
      await store.receive('oc_group', m, 't1');
      const controls: any = { codexReplySync: { registerSubmission: async () => {}, runNow: async () => {} } };
      input.executor = { submitMessage: async (args: any, beforeSend: any) => {
        await beforeSend({ threadId: 't1', knownTurnIds: [], transport: 'rpc' });
        return { status: 'accepted', submissionId: args.submissionId, threadId: 't1', transport: 'rpc', queueId: 'q1' };
      } };
      expect(await submitFeishuCodex(input, [m], store, controls, { replyTo: 'm1' })).toMatchObject({ status: 'accepted' });
      expect(store.records()[0]).toMatchObject({ status: 'accepted', queueId: 'q1', replyTo: 'm1' });
      const m2 = { ...m, messageId: 'm2' }; await store.receive('oc_group', m2, 't1');
      input.executor.submitMessage = async (args: any, beforeSend: any) => {
        await beforeSend({ threadId: 't1', knownTurnIds: [], transport: 'rpc' });
        await store.mark(args.submissionId, { status: 'completed', turnId: 'fast', completedAtMs: Date.now() });
        return { status: 'unknown', submissionId: args.submissionId, threadId: 't1', transport: 'rpc', message: 'lost ack' };
      };
      expect(await submitFeishuCodex(input, [m2], store, controls, { replyTo: 'm2' })).toMatchObject({ status: 'accepted' });
      expect(store.records().find(r => r.messages[0]?.messageId === 'm2')?.status).toBe('completed');

      // A message received during creation of the first thread follows that
      // one new binding, not an unrelated later rebind.
      const fresh = { ...m, messageId: 'fresh' }; await store.receive('oc_group', fresh);
      const seed = { ...m, messageId: 'seed' }; await store.receive('oc_group', seed);
      await store.mark('seed', { status: 'accepted', threadId: 't1', createdAtMs: 0 });
      input.executor.submitMessage = async (args: any, beforeSend: any) => {
        await beforeSend({ threadId: 't1', knownTurnIds: [], transport: 'rpc' });
        return { status: 'accepted', submissionId: args.submissionId, threadId: 't1', transport: 'rpc' };
      };
      expect(await submitFeishuCodex(input, [fresh], store, controls, { replyTo: 'fresh' })).toMatchObject({ status: 'accepted' });

      const failedWrite = { ...m, messageId: 'failed-write' }; await store.receive('oc_group', failedWrite, 't1');
      const originalMark = store.mark.bind(store); let writes = 0;
      const spy = vi.spyOn(store, 'mark').mockImplementation(async (id, patch, states) => {
        if (patch.status === 'accepted') throw new Error('disk full after ack');
        return originalMark(id, patch, states);
      });
      input.executor.submitMessage = async (args: any, beforeSend: any) => {
        await beforeSend({ threadId: 't1', knownTurnIds: [], transport: 'rpc' }); writes++;
        return { status: 'accepted', submissionId: args.submissionId, threadId: 't1', transport: 'rpc' };
      };
      expect(await submitFeishuCodex(input, [failedWrite], store, controls, { replyTo: 'failed-write' })).toMatchObject({ status: 'unknown' });
      expect(store.records().find(r => r.messages[0]?.messageId === 'failed-write')?.status).toBe('unknown');
      await expect(submitFeishuCodex(input, [failedWrite], store, controls, { replyTo: 'failed-write' })).rejects.toThrow('already submitted');
      expect(writes).toBe(1); spy.mockRestore();

      const race = { ...m, messageId: 'race' }; await store.receive('oc_group', race, 't1');
      input.executor.submitMessage = async (_args: any, beforeSend: any) => {
        catalog.upsertActive({ scopeId: 'oc_group', agentId: 'codex', cwdRealpath: initial.cwdRealpath,
          policyFingerprint: initial.policy.policyFingerprint, threadId: 'other' });
        await beforeSend({ threadId: 't1', knownTurnIds: [], transport: 'rpc' }); writes++;
        throw new Error('unreachable');
      };
      expect(await submitFeishuCodex(input, [race], store, controls, { replyTo: 'race' })).toMatchObject({ status: 'rejected' });
      expect(writes).toBe(1);
      catalog.upsertActive({ scopeId: 'oc_group', agentId: 'codex', cwdRealpath: initial.cwdRealpath,
        policyFingerprint: initial.policy.policyFingerprint, threadId: 't1' });
      catalog.archiveCodexThread('t1'); expect(await prepareRunFlow(input)).toMatchObject({ ok: false, rejectReason: { code: 'session-archived' } });
      await catalog.flush();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
