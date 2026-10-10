import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexSubmissionStore } from '../../../src/session/codex-submissions';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'bridge-outbox-')); dirs.push(dir); return join(dir, 'state.json'); }
const message = (id: string) => ({ messageId: id, chatId: 'group', senderId: 'user', chatType: 'group', content: 'same text' }) as any;
describe('durable Codex intake', () => {
  it('persists before acknowledging intake and deduplicates IDs but not text', async () => {
    const path = await fixture(); const store = new CodexSubmissionStore(path); await store.load();
    expect(await store.receive('group', message('m1'), 't1')).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8')).records[0].messages[0].messageId).toBe('m1');
    expect(await store.receive('group', message('m1'), 't1')).toBe(false);
    expect(await store.receive('group', message('m2'), 't1')).toBe(true);
    expect(store.records()).toHaveLength(2);
  });
  it('reloads sending as unknown and never changes accepted to pending', async () => {
    const path = await fixture(); const store = new CodexSubmissionStore(path); await store.load();
    await store.receive('group', message('m1')); await store.mark('m1', { status: 'sending' });
    await store.receive('group', message('m2')); await store.mark('m2', { status: 'accepted', queueId: 'q2' });
    const reloaded = new CodexSubmissionStore(path); await reloaded.load();
    expect(reloaded.records().map(r => r.status)).toEqual(['unknown', 'accepted']);
  });
  it('combines a debounce batch without losing its original IDs', async () => {
    const path = await fixture(); const store = new CodexSubmissionStore(path); await store.load();
    await store.receive('group', message('m1')); await store.receive('group', message('m2'));
    await store.prepare({ ...store.records()[0]!, id: 's1', messages: [message('m1'), message('m2')],
      threadId: 't1', prompt: 'combined', knownTurnIds: ['old'] });
    expect(store.records()).toHaveLength(1); expect(store.records()[0]!.messages).toHaveLength(2);
    expect(await store.receive('group', message('m2'))).toBe(false);
  });
  it('fails closed for corrupt state and failed writes', async () => {
    const path = await fixture(); await writeFile(path, '{bad');
    await expect(new CodexSubmissionStore(path).load()).rejects.toThrow();
    const store = new CodexSubmissionStore(join(path, 'child.json')); // parent is a file
    await expect(store.receive('group', message('m1'))).rejects.toThrow();
    expect(store.records()).toEqual([]);
  });
  it('cleans completed records at seven days but retains unresolved records', async () => {
    const path = await fixture(); let now = 0; const store = new CodexSubmissionStore(path, () => now); await store.load();
    await store.receive('group', message('m1')); await store.mark('m1', { status: 'completed', completedAtMs: 0 });
    await store.receive('group', message('m2')); await store.mark('m2', { status: 'unknown' });
    now = 7 * 86400000; await store.flush();
    expect(store.records().map(r => r.id)).toEqual(['m2']);
  });
});
