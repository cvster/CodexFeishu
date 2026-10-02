import { describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import type { AgentRun } from '../../../src/agent/types';

const run = (durable = true): AgentRun => ({
  runId: 'test', events: (async function* () {})(),
  stop: vi.fn(async () => {}), waitForExit: vi.fn(async () => true),
  ...(durable ? { detach: vi.fn(async () => {}) } : {}),
});

describe('ActiveRuns service lifecycle', () => {
  it('detaches durable tasks without marking interruption or cancelling them', async () => {
    const active = new ActiveRuns(); const task = run();
    const handle = active.register('group', task);
    await active.disconnectAll();
    expect(task.detach).toHaveBeenCalledOnce();
    expect(task.stop).not.toHaveBeenCalled();
    expect(handle.detached).toBe(true); expect(handle.interrupted).toBe(false);
    expect(active.scopes()).toEqual([]);
  });
  it('keeps explicit user cancellation separate from disconnect', async () => {
    const active = new ActiveRuns(); const task = run();
    const handle = active.register('group', task);
    await active.stopScopes(['group']);
    expect(task.stop).toHaveBeenCalledOnce(); expect(task.detach).not.toHaveBeenCalled();
    expect(handle.interrupted).toBe(true); expect(handle.detached).toBeUndefined();
  });
  it('preserves non-durable adapter cleanup and clears reservations', async () => {
    const active = new ActiveRuns(); const task = run(false);
    active.register('legacy', task); active.reserve('pending');
    await active.disconnectAll();
    expect(task.stop).toHaveBeenCalledOnce(); expect(active.reserve('pending')).toBeTypeOf('function');
  });
});
