import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue';
afterEach(() => vi.useRealTimers());
describe('debounced submission scheduling', () => {
  it('preserves blocked messages and flushes in order after a 600ms quiet window', async () => {
    vi.useFakeTimers(); const batches: any[] = []; const q = new PendingQueue(600, (scope, messages) => batches.push({ scope, messages }));
    q.block('g'); q.push('g', { messageId: 'm1' } as any); q.push('g', { messageId: 'm2' } as any);
    expect(q.snapshot()[0]!.messages.map(m => m.messageId)).toEqual(['m1', 'm2']);
    await vi.advanceTimersByTimeAsync(1000); expect(batches).toEqual([]);
    q.unblock('g'); await vi.advanceTimersByTimeAsync(599); expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); expect(batches[0].messages.map((m: any) => m.messageId)).toEqual(['m1', 'm2']);
    q.cancelAll();
  });
});
