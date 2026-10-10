import { describe, expect, it, vi } from 'vitest';
import * as core from '../../../packages/codex-core/src/index';

const input = { submissionId: 's1', clientUserMessageId: 'bridge-1', threadId: 't1', prompt: '继续\n' };
const submit = (deps: any) => (core as any).submitCodexInput(input, deps);
function harness() {
  const calls: string[] = [];
  return {
    calls,
    shared: {
      connect: async () => { calls.push('connect'); },
      listQueuedSubmissions: async () => { calls.push('list'); return []; },
      addQueuedSubmission: async (value: any) => {
        calls.push('add'); expect(value).toEqual(input);
        return { id: 'q1', clientUserMessageId: 'bridge-1', input: [] };
      },
    },
    beforeSend: async (transport: string) => { calls.push(`persist-${transport}`); },
    runCli: async () => { calls.push('cli'); return { code: 0, stdout: 'Queued message q2 for thread t1.', stderr: '' }; },
  };
}
describe('acceptance-only Codex submission', () => {
  it('rpc_acceptance_preserves_client_id', async () => {
    const h = harness();
    expect(await submit(h)).toEqual({ status: 'accepted', submissionId: 's1', threadId: 't1',
      transport: 'rpc', queueId: 'q1', clientUserMessageId: 'bridge-1' });
    expect(h.calls).toEqual(['connect', 'list', 'persist-rpc', 'add']);
  });
  it('unsupported_probe_uses_cli_once', async () => {
    const h = harness(); h.shared.listQueuedSubmissions = async () => { throw new Error('Unknown method'); };
    expect(await submit(h)).toMatchObject({ status: 'accepted', transport: 'cli', queueId: 'q2' });
    expect(h.calls.filter(c => c === 'cli')).toHaveLength(1);
  });
  it('lost_rpc_ack_never_falls_back', async () => {
    const h = harness(); h.shared.addQueuedSubmission = () => new Promise(() => {});
    expect(await submit({ ...h, timeoutMs: 10 })).toMatchObject({ status: 'unknown', transport: 'rpc' });
    expect(h.calls).not.toContain('cli');
  });
  it('cli_ack_without_turn_returns_immediately', async () => {
    const h = harness();
    expect(await submit({ ...h, shared: undefined })).toMatchObject({ status: 'accepted', queueId: 'q2' });
  });
  it('probe_race_does_not_double_submit', async () => {
    const h = harness(); h.shared.addQueuedSubmission = async () => { h.calls.push('add'); throw new Error('socket closed'); };
    expect(await submit(h)).toMatchObject({ status: 'unknown' });
    expect(h.calls.filter(c => c === 'add')).toHaveLength(1); expect(h.calls).not.toContain('cli');
  });
  it('does not send after durable beforeSend fails', async () => {
    const h = harness(); h.beforeSend = async () => { throw new Error('disk full'); };
    await expect(submit(h)).rejects.toThrow('disk full'); expect(h.calls).not.toContain('add');
  });
  it('does not consider missing CLI acknowledgement accepted', async () => {
    const h = harness(); h.runCli = async () => ({ code: 0, stdout: '', stderr: '' });
    expect(await submit({ ...h, shared: undefined })).toMatchObject({ status: 'unknown' });
  });
});
