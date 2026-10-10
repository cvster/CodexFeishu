import { readFile } from 'node:fs/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { writeFileAtomic } from '../platform/atomic-write';

export type CodexSubmissionState = 'pending' | 'sending' | 'accepted' | 'rejected' | 'unknown' | 'completed' | 'cancelled';
export interface CodexSubmissionRecord {
  id: string;
  scope: string;
  messages: NormalizedMessage[];
  status: CodexSubmissionState;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  expectedThreadId?: string;
  threadId?: string;
  turnId?: string;
  prompt?: string;
  images?: string[];
  clientUserMessageId?: string;
  queueId?: string;
  transport?: 'rpc' | 'cli';
  knownTurnIds?: string[];
  replyTo?: string;
  replyInThread?: boolean;
  error?: string;
}
const states = new Set<CodexSubmissionState>(['pending', 'sending', 'accepted', 'rejected', 'unknown', 'completed', 'cancelled']);
const RETENTION_MS = 7 * 86_400_000;

/** Small profile-local outbox; unknown writes are never replayed automatically. */
export class CodexSubmissionStore {
  private data: CodexSubmissionRecord[] = [];
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  async load(): Promise<void> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const parsed = JSON.parse(text);
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('Invalid Codex submission ledger');
    const ids = new Set<string>(); const messageIds = new Set<string>();
    for (const r of parsed.records) {
      if (!r || typeof r.id !== 'string' || ids.has(r.id) || typeof r.scope !== 'string' ||
        !states.has(r.status) || !Array.isArray(r.messages) || typeof r.createdAtMs !== 'number' ||
        typeof r.updatedAtMs !== 'number') throw new Error('Invalid Codex submission record');
      ids.add(r.id);
      for (const m of r.messages) {
        if (!m || typeof m.messageId !== 'string' || messageIds.has(m.messageId)) throw new Error('Invalid/duplicate inbox message');
        messageIds.add(m.messageId);
      }
    }
    this.data = parsed.records;
    await this.transaction(() => {
      for (const r of this.data) if (r.status === 'sending') {
        r.status = 'unknown'; r.error = 'Bridge stopped before acceptance was recorded'; r.updatedAtMs = this.now();
      }
    });
  }

  records(): CodexSubmissionRecord[] { return structuredClone(this.data); }

  async receive(scope: string, message: NormalizedMessage, expectedThreadId?: string): Promise<boolean> {
    return this.transaction(() => {
      if (this.data.some(r => r.messages.some(m => m.messageId === message.messageId))) return false;
      this.data.push({ id: message.messageId, scope, messages: [structuredClone(message)],
        status: 'pending', createdAtMs: this.now(), updatedAtMs: this.now(), expectedThreadId });
      return true;
    });
  }

  async prepare(record: CodexSubmissionRecord): Promise<void> {
    await this.transaction(() => {
      const ids = new Set(record.messages.map(m => m.messageId));
      const overlapping = this.data.filter(r => r.messages.some(m => ids.has(m.messageId)));
      if (overlapping.some(r => r.status !== 'pending' && r.id !== record.id)) throw new Error('Message was already submitted');
      this.data = this.data.filter(r => r.id !== record.id && !r.messages.some(m => ids.has(m.messageId)));
      this.data.push({ ...structuredClone(record), updatedAtMs: this.now() });
    });
  }

  async mark(id: string, patch: Partial<Omit<CodexSubmissionRecord, 'id' | 'messages' | 'scope'>>,
    expectedStates?: readonly CodexSubmissionState[]): Promise<void> {
    await this.transaction(() => {
      const record = this.data.find(r => r.id === id);
      if (!record) throw new Error(`Submission ${id} missing`);
      if (expectedStates && !expectedStates.includes(record.status)) throw new Error('Submission state changed before send');
      // A completed turn is stronger evidence than an acknowledgement arriving later.
      const next = structuredClone(patch);
      if (record.status === 'completed' && next.status && next.status !== 'completed') delete next.status;
      Object.assign(record, next, { updatedAtMs: this.now() });
    });
  }

  async flush(): Promise<void> { await this.transaction(() => {}); }

  private transaction<T>(mutate: () => T): Promise<T> {
    const next = this.writing.then(async () => {
      const old = structuredClone(this.data);
      try {
        const value = mutate();
        this.data = this.data.filter(r => !(r.status === 'completed' && r.completedAtMs !== undefined &&
          this.now() - r.completedAtMs >= RETENTION_MS));
        await writeFileAtomic(this.path, `${JSON.stringify({ version: 1, records: this.data }, null, 2)}\n`, { mode: 0o600 });
        return value;
      } catch (error) { this.data = old; throw error; }
    });
    this.writing = next.catch(() => {});
    return next;
  }
}
