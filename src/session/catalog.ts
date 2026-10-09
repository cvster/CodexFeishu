import { randomUUID } from 'node:crypto';
import { open, readFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import type { AgentCapabilityId } from '../agent/capability';
import { writeFileAtomic } from '../platform/atomic-write';

export type CatalogAgentId = AgentCapabilityId;
export type SessionCatalogStatus = 'active' | 'archived';

export interface SessionCatalogIdentity {
  scopeId: string;
  agentId: CatalogAgentId;
  cwdRealpath: string;
  policyFingerprint: string;
}

export interface SessionCatalogEntry extends SessionCatalogIdentity {
  key: string;
  fingerprintVersion?: number;
  /** Feishu app that last established this chat binding. Legacy entries omit it. */
  botAppId?: string;
  /** Number of recent completed Codex turns to replay when this chat is first attached. */
  recentTurnReplayCount?: number;
  status: SessionCatalogStatus;
  /** Last binding establishment time; archival must not reorder current bindings. */
  boundAt?: number;
  updatedAt: number;
  sessionId?: string;
  threadId?: string;
  lastSummary?: string;
}

export interface UpsertSessionCatalogInput extends SessionCatalogIdentity {
  /** Only an explicit user-selected resume may reopen an archived group. */
  rebindArchivedScope?: boolean;
  now?: number;
  botAppId?: string;
  /** `null` explicitly clears a pending creation-time replay marker. */
  recentTurnReplayCount?: number | null;
  sessionId?: string;
  threadId?: string;
  lastSummary?: string;
}

export interface ArchiveSessionCatalogInput extends SessionCatalogIdentity {
  now?: number;
}

export interface SessionCatalogGcOptions {
  now?: number;
  maxArchivedAgeMs?: number;
  maxEntriesPerScope?: number;
  maxEntriesPerProfile?: number;
}

const DEFAULT_MAX_ARCHIVED_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 20;
const DEFAULT_MAX_ENTRIES_PER_PROFILE = 1000;
const KEY_SEPARATOR = '\x1f';
const CURRENT_FINGERPRINT_VERSION = 3;

export function sessionCatalogKey(input: SessionCatalogIdentity): string {
  return [
    input.scopeId,
    input.agentId,
    input.cwdRealpath,
    input.policyFingerprint,
  ].join(KEY_SEPARATOR);
}

export class SessionCatalog {
  private data = new Map<string, SessionCatalogEntry>();
  // Separate from GC'd history: an archive must not expire into a new task.
  private archivedThreads = new Set<string>();
  private archivedScopes = new Map<string, string>();
  private saving: Promise<void> = Promise.resolve();
  private persistenceError: unknown;
  private readonly path: string;

  constructor(path = `${paths.sessionsFile}.catalog.json`) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!Array.isArray(raw)) {
        throw new Error('Invalid session catalog');
      }
      this.data.clear();
      for (const item of raw) {
        const entry = normalizeEntry(item);
        if (!entry) continue;
        this.data.set(entry.key, entry);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.fail('session-catalog', err, { step: 'load' });
        this.data.clear();
      }
    }
    try {
      const state = JSON.parse(await readFile(`${this.path}.archives.json`, 'utf8'));
      if (!Array.isArray(state.threads) || !Array.isArray(state.scopes) ||
          !state.threads.every((id: unknown) => typeof id === 'string') ||
          !state.scopes.every((pair: unknown) => Array.isArray(pair) && pair.length === 2 && pair.every((v) => typeof v === 'string'))) {
        throw new Error('Invalid persistent archive state');
      }
      this.archivedThreads = new Set(state.threads);
      this.archivedScopes = new Map(state.scopes);
    } catch (err) {
      // A damaged archive ledger must fail closed, not silently reopen groups.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  isScopeArchived(scopeId: string): boolean { return this.archivedScopes.has(scopeId); }
  isThreadArchived(threadId: string): boolean { return this.archivedThreads.has(threadId); }

  /** Actual Codex archival, unlike retiring an obsolete bridge binding. */
  archiveCodexThread(threadId: string, now = Date.now()): void {
    this.archivedThreads.add(threadId);
    const latest = new Map<string, SessionCatalogEntry>();
    for (const entry of this.data.values()) {
      if (entry.agentId !== 'codex') continue;
      const current = latest.get(entry.scopeId);
      if (!current || (entry.status === 'active' && current.status !== 'active') ||
          (entry.status === current.status && (entry.boundAt ?? entry.updatedAt) >= (current.boundAt ?? current.updatedAt))) {
        latest.set(entry.scopeId, entry);
      }
    }
    for (const entry of latest.values()) {
      if (entry.threadId === threadId) this.archivedScopes.set(entry.scopeId, threadId);
    }
    this.archiveThread(threadId, now);
    // Retire obsolete active rows in a closed group too: reply/name/question
    // observers must not continue through an older policy or workspace binding.
    for (const [key, entry] of this.data) {
      if (entry.agentId === 'codex' && entry.status === 'active' && this.isScopeArchived(entry.scopeId)) {
        this.data.set(key, { ...entry, status: 'archived', updatedAt: now });
      }
    }
    this.schedulePersist();
  }

  activeFor(input: SessionCatalogIdentity): SessionCatalogEntry | undefined {
    const key = sessionCatalogKey(input);
    const entry = this.data.get(key) ?? this.migrateLegacyActive(input);
    if (!entry || entry.status !== 'active') return undefined;
    if (!matchesIdentity(entry, input)) return undefined;
    if (!isValidAgentEntry(entry)) {
      log.warn('session-catalog', 'damaged-entry', {
        key: entry.key,
        agentId: entry.agentId,
      });
      return undefined;
    }
    return { ...entry };
  }

  upsertActive(input: UpsertSessionCatalogInput): SessionCatalogEntry {
    assertAgentIdentity(input);
    if (input.agentId === 'codex' && input.threadId && this.isThreadArchived(input.threadId)) {
      throw new Error('会话已归档，不能重新绑定。');
    }
    if (this.isScopeArchived(input.scopeId)) {
      if (!input.rebindArchivedScope) throw new Error('会话已归档，请手动绑定未归档的会话。');
      this.archivedScopes.delete(input.scopeId);
    }
    const key = sessionCatalogKey(input);
    const existing = this.data.get(key);
    const recentTurnReplayCount = input.recentTurnReplayCount === null
      ? undefined
      : normalizeReplayCount(input.recentTurnReplayCount ?? existing?.recentTurnReplayCount);
    const entry: SessionCatalogEntry = {
      key,
      fingerprintVersion: CURRENT_FINGERPRINT_VERSION,
      ...(input.botAppId ? { botAppId: input.botAppId } : {}),
      ...(recentTurnReplayCount !== undefined ? { recentTurnReplayCount } : {}),
      scopeId: input.scopeId,
      agentId: input.agentId,
      cwdRealpath: input.cwdRealpath,
      policyFingerprint: input.policyFingerprint,
      status: 'active',
      boundAt: input.now ?? Date.now(),
      updatedAt: input.now ?? Date.now(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.lastSummary ? { lastSummary: input.lastSummary } : {}),
    };
    // Preserve last-establishment order even when timestamps tie and an
    // existing policy/workspace key is reused. Map.set alone keeps old order.
    this.data.delete(key);
    this.data.set(key, entry);
    this.schedulePersist();
    return { ...entry };
  }

  archiveActive(input: ArchiveSessionCatalogInput): boolean {
    const key = sessionCatalogKey(input);
    const entry = this.data.get(key);
    if (!entry || entry.status !== 'active') return false;
    this.data.set(key, {
      ...entry,
      status: 'archived',
      updatedAt: input.now ?? Date.now(),
    });
    this.schedulePersist();
    return true;
  }

  entries(): SessionCatalogEntry[] {
    return [...this.data.values()].map((entry) => ({ ...entry }));
  }

  gc(options: SessionCatalogGcOptions = {}): void {
    const now = options.now ?? Date.now();
    const maxArchivedAgeMs = options.maxArchivedAgeMs ?? DEFAULT_MAX_ARCHIVED_AGE_MS;
    const maxEntriesPerScope = options.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE;
    const maxEntriesPerProfile =
      options.maxEntriesPerProfile ?? DEFAULT_MAX_ENTRIES_PER_PROFILE;

    for (const [key, entry] of this.data.entries()) {
      if (entry.status === 'archived' && now - entry.updatedAt > maxArchivedAgeMs) {
        this.data.delete(key);
      }
    }

    for (const scopeId of new Set([...this.data.values()].map((entry) => entry.scopeId))) {
      const scoped = [...this.data.values()]
        .filter((entry) => entry.scopeId === scopeId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      for (const entry of scoped.slice(maxEntriesPerScope)) {
        this.data.delete(entry.key);
      }
    }

    const all = [...this.data.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const entry of all.slice(maxEntriesPerProfile)) {
      this.data.delete(entry.key);
    }
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
    if (this.persistenceError) throw this.persistenceError;
  }

  async replaceForTest(entries: SessionCatalogEntry[]): Promise<void> {
    await this.saving;
    this.data = new Map(entries.map((entry) => [entry.key, { ...entry }]));
    await this.persist();
  }

  /** Archive every active bridge binding that points at the same Codex thread. */
  archiveThread(threadId: string, now = Date.now()): number {
    let archived = 0;
    for (const [key, entry] of this.data.entries()) {
      if (entry.status !== 'active' || entry.agentId !== 'codex' || entry.threadId !== threadId) continue;
      this.data.set(key, { ...entry, status: 'archived', updatedAt: now });
      archived += 1;
    }
    if (archived > 0) this.schedulePersist();
    return archived;
  }

  /** Consume the one-shot history replay marker after the new group is first observed. */
  clearRecentTurnReplay(scopeId: string, threadId: string): number {
    let cleared = 0;
    for (const [key, entry] of this.data.entries()) {
      if (
        entry.status !== 'active' ||
        entry.scopeId !== scopeId ||
        entry.threadId !== threadId ||
        entry.recentTurnReplayCount === undefined
      ) continue;
      const { recentTurnReplayCount: _ignored, ...next } = entry;
      this.data.set(key, next);
      cleared += 1;
    }
    if (cleared > 0) this.schedulePersist();
    return cleared;
  }

  private migrateLegacyActive(input: SessionCatalogIdentity): SessionCatalogEntry | undefined {
    const candidates = [...this.data.values()]
      .filter(
        (entry) =>
          entry.status === 'active' &&
          (entry.fingerprintVersion ?? 2) < CURRENT_FINGERPRINT_VERSION &&
          entry.scopeId === input.scopeId &&
          entry.agentId === input.agentId &&
          entry.cwdRealpath === input.cwdRealpath &&
          isValidAgentEntry(entry),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const selected = candidates[0];
    if (!selected) return undefined;

    for (const legacy of candidates) {
      this.data.set(legacy.key, {
        ...legacy,
        status: 'archived',
      });
    }

    const key = sessionCatalogKey(input);
    const migrated: SessionCatalogEntry = {
      ...selected,
      ...input,
      key,
      fingerprintVersion: CURRENT_FINGERPRINT_VERSION,
      status: 'active',
    };
    this.data.set(key, migrated);
    this.schedulePersist();
    log.info('session-catalog', 'fingerprint-migrated', {
      scopeId: input.scopeId,
      agentId: input.agentId,
      legacyEntries: candidates.length,
    });
    return migrated;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => { await this.persist(); this.persistenceError = undefined; })
      .catch((err: unknown) => {
        this.persistenceError = err;
        log.fail('session-catalog', err, { step: 'persist' });
      });
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFileAtomic(`${this.path}.archives.json`, `${JSON.stringify({
      threads: [...this.archivedThreads], scopes: [...this.archivedScopes],
    })}\n`);
    const tmp = `${this.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify(this.entries(), null, 2)}\n`;
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(payload, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.path);
    try {
      const dir = await open(dirname(this.path), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // Directory fsync is not available on every platform.
    }
  }
}

function normalizeEntry(input: unknown): SessionCatalogEntry | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Partial<SessionCatalogEntry>;
  if (
    typeof raw.key !== 'string' ||
    typeof raw.scopeId !== 'string' ||
    (raw.agentId !== 'claude' && raw.agentId !== 'codex') ||
    typeof raw.cwdRealpath !== 'string' ||
    typeof raw.policyFingerprint !== 'string' ||
    (raw.status !== 'active' && raw.status !== 'archived') ||
    typeof raw.updatedAt !== 'number'
  ) {
    return undefined;
  }
  return {
    key: raw.key,
    fingerprintVersion:
      typeof raw.fingerprintVersion === 'number' ? raw.fingerprintVersion : 2,
    ...(typeof raw.botAppId === 'string' ? { botAppId: raw.botAppId } : {}),
    ...(normalizeReplayCount(raw.recentTurnReplayCount) !== undefined
      ? { recentTurnReplayCount: normalizeReplayCount(raw.recentTurnReplayCount) }
      : {}),
    scopeId: raw.scopeId,
    agentId: raw.agentId,
    cwdRealpath: raw.cwdRealpath,
    policyFingerprint: raw.policyFingerprint,
    status: raw.status,
    boundAt: typeof raw.boundAt === 'number' ? raw.boundAt : raw.updatedAt,
    updatedAt: raw.updatedAt,
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
    ...(typeof raw.lastSummary === 'string' ? { lastSummary: raw.lastSummary } : {}),
  };
}

function normalizeReplayCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function matchesIdentity(entry: SessionCatalogEntry, input: SessionCatalogIdentity): boolean {
  return (
    entry.scopeId === input.scopeId &&
    entry.agentId === input.agentId &&
    entry.cwdRealpath === input.cwdRealpath &&
    entry.policyFingerprint === input.policyFingerprint &&
    entry.key === sessionCatalogKey(input)
  );
}

function isValidAgentEntry(entry: SessionCatalogEntry): boolean {
  if (entry.agentId === 'claude') return Boolean(entry.sessionId) && !entry.threadId;
  return Boolean(entry.threadId) && !entry.sessionId;
}

function assertAgentIdentity(input: UpsertSessionCatalogInput): void {
  if (input.agentId === 'claude') {
    if (!input.sessionId || input.threadId) {
      throw new Error('Claude catalog entries require sessionId and must not include threadId');
    }
    return;
  }
  if (!input.threadId || input.sessionId) {
    throw new Error('Codex catalog entries require threadId and must not include sessionId');
  }
}
