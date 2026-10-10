import { describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

describe('RunExecutor policy runtime options', () => {
  it('releases scope and pool after acceptance without waiting for a turn', async () => {
    const activeRuns = new ActiveRuns(); const pool = new ProcessPool(() => 1); const calls: string[] = [];
    const agent: any = { id: 'codex', displayName: 'test', isAvailable: async () => true,
      run: () => { throw new Error('Legacy observer must not start'); },
      submit: async (opts: any, beforeSend: any) => { calls.push(opts.prompt); await beforeSend({ threadId: 't1', knownTurnIds: [] });
        return { status: 'accepted', submissionId: opts.runId, threadId: 't1', transport: 'rpc', queueId: opts.runId }; } };
    const executor = new RunExecutor({ agent, pool, activeRuns, now: () => 1000 });
    await executor.submitMessage({ scopeId: 'g', policy: policy() }, async () => {});
    await executor.submitMessage({ scopeId: 'g', policy: policy({ prompt: 'second' }) }, async () => {});
    expect(calls).toEqual(['hello', 'second']); expect(activeRuns.scopes()).toEqual([]);
    const release = pool.tryAcquire(); expect(release).toBeTypeOf('function'); release?.();
  });
  it('rechecks validation after waiting for capacity and releases scope on failure', async () => {
    const pool = new ProcessPool(() => 1); const release = await pool.acquire();
    let archived = false; const submit = vi.fn(); const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent: { id: 'codex', submit } as any, pool, activeRuns, now: () => 1000 });
    const result = executor.submitMessage({ scopeId: 'g', policy: policy(), validateBeforeStart: () => {
      if (archived) throw new Error('archived'); } }, async () => {});
    archived = true; release(); await expect(result).rejects.toThrow('archived');
    expect(submit).not.toHaveBeenCalled(); expect(activeRuns.reserve('g')).toBeTypeOf('function');
  });
  it('drains submission acknowledgements on shutdown without waiting for execution or cancelling it', async () => {
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); let drained = false;
    const executor = new RunExecutor({ agent: { id: 'codex', submit: async (opts: any) => { await pending;
      return { status: 'accepted', submissionId: opts.runId, threadId: 't', transport: 'rpc' }; } } as any,
      pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns(), now: () => 1000 });
    const submission = executor.submitMessage({ scopeId: 'g', policy: policy() }, async () => {});
    const shutdown = executor.waitForSubmissions().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); release(); await submission; await shutdown; expect(drained).toBe(true);
  });
  it('passes policy sandbox and permission mode into each agent run', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-policy',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-policy',
      policy: policy({
        sandbox: 'workspace-write',
        permissionMode: 'acceptEdits',
      }),
    });

    expect(agent.runOptions[0]).toMatchObject({
      runId: 'run-policy',
      sandbox: 'workspace-write',
      permissionMode: 'acceptEdits',
    });

    await collect(execution.subscribe());
  });
});

function policy(overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: '/tmp/repo',
    cwdRealpath: '/tmp/repo',
    accessMode: 'workspace',
    sandbox: 'workspace-write',
    permissionMode: 'acceptEdits',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}
