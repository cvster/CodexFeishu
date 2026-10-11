import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexQueueContinuationError, stopCodexSubmissions, waitForCodexIntake } from '../../../src/bot/codex-submission-stop';
import { CodexSubmissionStore } from '../../../src/session/codex-submissions';

function writer(type = 'active') {
  return {
    readThreadStatus: vi.fn(async () => ({ type: 'idle' })).mockResolvedValueOnce({ type }),
    readThread: vi.fn(async () => ({ turns: [{ id: 'old', status: 'completed' }, { id: 'live', status: 'inProgress' }] })),
    interruptTurn: vi.fn(async () => {}),
    listQueuedSubmissions: vi.fn(async () => [{ id: 'next' }, { id: 'later' }]),
    startQueuedTurn: vi.fn(async () => 'next-turn'),
    deleteQueuedTurn: vi.fn(async () => {}),
  };
}

describe('stop current Codex response and continue queue', () => {
  it('waits for interruption acknowledgement before starting only the queue head', async () => {
    const w = writer();
    let acknowledge!: () => void;
    w.interruptTurn.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    const stopping = stopCodexSubmissions('t', w as any);
    await vi.waitFor(() => expect(w.interruptTurn).toHaveBeenCalledWith('t', 'live'));
    expect(w.listQueuedSubmissions).not.toHaveBeenCalled();
    expect(w.startQueuedTurn).not.toHaveBeenCalled();
    acknowledge();
    expect(await stopping).toBe(true);
    expect(w.startQueuedTurn).toHaveBeenCalledTimes(1);
    expect(w.startQueuedTurn).toHaveBeenCalledWith('t', 'next');
    expect(w.deleteQueuedTurn).not.toHaveBeenCalled();
  });

  it.each(['idle', 'notLoaded'])('leaves queued input alone when the thread is %s', async type => {
    const w = writer(type);
    expect(await stopCodexSubmissions('t', w as any)).toBe(false);
    expect(w.interruptTurn).not.toHaveBeenCalled();
    expect(w.listQueuedSubmissions).not.toHaveBeenCalled();
    expect(w.startQueuedTurn).not.toHaveBeenCalled();
    expect(w.deleteQueuedTurn).not.toHaveBeenCalled();
  });

  it('stops without starting anything when there is no subsequent message', async () => {
    const w = writer(); w.listQueuedSubmissions.mockResolvedValue([]);
    expect(await stopCodexSubmissions('t', w as any)).toBe(true);
    expect(w.startQueuedTurn).not.toHaveBeenCalled();
  });

  it('does not start a second turn when another client has already continued the queue', async () => {
    const w = writer(); w.readThreadStatus.mockResolvedValue({ type: 'active' });
    expect(await stopCodexSubmissions('t', w as any)).toBe(true);
    expect(w.startQueuedTurn).not.toHaveBeenCalled();
  });

  it('never starts another message after an unconfirmed interruption', async () => {
    const w = writer(); w.interruptTurn.mockRejectedValue(new Error('interrupt timeout'));
    await expect(stopCodexSubmissions('t', w as any)).rejects.toThrow('interrupt timeout');
    expect(w.listQueuedSubmissions).not.toHaveBeenCalled();
    expect(w.startQueuedTurn).not.toHaveBeenCalled();
  });

  it.each(['list', 'start'])('reports a partial success without retrying when queue %s fails', async stage => {
    const w = writer();
    if (stage === 'list') w.listQueuedSubmissions.mockRejectedValue(new Error('connection lost'));
    else w.startQueuedTurn.mockRejectedValue(new Error('connection lost'));
    await expect(stopCodexSubmissions('t', w as any)).rejects.toBeInstanceOf(CodexQueueContinuationError);
    expect(w.interruptTurn).toHaveBeenCalledTimes(1);
    expect(w.startQueuedTurn).toHaveBeenCalledTimes(stage === 'start' ? 1 : 0);
  });

  it('does not guess the current turn when the snapshot has no active turn', async () => {
    const w = writer(); w.readThread.mockResolvedValue({ turns: [] });
    await expect(stopCodexSubmissions('t', w as any)).rejects.toThrow('无法确认正在运行的轮次');
    expect(w.interruptTurn).not.toHaveBeenCalled();
    expect(w.startQueuedTurn).not.toHaveBeenCalled();
  });

  it('includes messages still pending or sending before waking the queue, without cancelling them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-stop-intake-'));
    try {
      const store = new CodexSubmissionStore(join(dir, 'outbox.json')); await store.load();
      await store.receive('g', { messageId: 'next' } as any, 't');
      await store.receive('other', { messageId: 'unrelated' } as any, 'other-thread');
      const w = writer(); w.listQueuedSubmissions.mockResolvedValue([]);
      const stopping = stopCodexSubmissions('t', w as any, () => waitForCodexIntake('g', store, 1000));
      await vi.waitFor(() => expect(w.interruptTurn).toHaveBeenCalledTimes(1));
      expect(w.listQueuedSubmissions).not.toHaveBeenCalled();
      await store.mark('next', { status: 'sending' });
      expect(w.startQueuedTurn).not.toHaveBeenCalled();
      w.listQueuedSubmissions.mockResolvedValue([{ id: 'next' }]);
      await store.mark('next', { status: 'accepted', queueId: 'next' });
      expect(await stopping).toBe(true);
      expect(w.startQueuedTurn).toHaveBeenCalledWith('t', 'next');
      expect(store.records().map(r => r.status)).toEqual(['accepted', 'pending']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('bounds the intake wait and preserves input after a timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-stop-timeout-'));
    try {
      const store = new CodexSubmissionStore(join(dir, 'outbox.json')); await store.load();
      await store.receive('g', { messageId: 'next' } as any, 't');
      const w = writer();
      await expect(stopCodexSubmissions('t', w as any, () => waitForCodexIntake('g', store, 0)))
        .rejects.toThrow('当前响应已停止，但后续队列继续执行未确认');
      expect(w.startQueuedTurn).not.toHaveBeenCalled();
      expect(store.records()[0]?.status).toBe('pending');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
