import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexSubmissionStore } from '../../../src/session/codex-submissions';
import { stopCodexSubmissions } from '../../../src/bot/codex-submission-stop';
describe('explicit Codex cancellation', () => {
  it('deletes only confirmed queue IDs owned by the target group', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-stop-'));
    try {
      const store = new CodexSubmissionStore(join(dir, 'outbox.json')); await store.load();
      for (const [id, scope] of [['m1', 'g'], ['m2', 'other']] as const) {
        await store.receive(scope, { messageId: id } as any, 't'); await store.mark(id, { status: 'accepted', queueId: id, threadId: 't' });
      }
      const deleted: string[] = [];
      const writer: any = { readThreadStatus: async () => ({ type: 'idle' }),
        listQueuedSubmissions: async () => [{ id: 'm1' }, { id: 'm2' }, { id: 'desktop' }],
        deleteQueuedTurn: async (_t: string, id: string) => { deleted.push(id); } };
      expect(await stopCodexSubmissions('g', 't', store, writer)).toBe(true);
      expect(deleted).toEqual(['m1']); expect(store.records().map(r => r.status)).toEqual(['cancelled', 'accepted']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('interrupts the actual active turn and never resumes or deletes unrelated queue input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-stop-turn-'));
    try {
      const store = new CodexSubmissionStore(join(dir, 'outbox.json')); await store.load(); const ids: string[] = [];
      const writer: any = { readThreadStatus: async () => ({ type: 'active' }),
        readThread: async () => ({ turns: [{ id: 'old', status: 'completed' }, { id: 'live', status: 'inProgress' }] }),
        interruptTurn: async (_t: string, id: string) => { ids.push(id); } };
      expect(await stopCodexSubmissions('g', 't', store, writer)).toBe(true); expect(ids).toEqual(['live']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
