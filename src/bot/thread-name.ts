import { readFile } from 'node:fs/promises';
import type { LarkChannel } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { SessionCatalogEntry } from '../session/catalog';
import type { CodexThreadSnapshot } from '../session/codex-thread-reader';
import { renameChat } from './group';
import type { KnownChat } from './lark-info';

const CHAT_CHECK_INTERVAL_MS = 10_000;

interface NameState {
  groupName: string;
  threadName: string;
  /** Ignore an old snapshot until our own write has been observed. */
  previousGroupName?: string;
  previousThreadName?: string;
}

export interface CodexNameSyncOptions {
  channel: LarkChannel;
  agent: Pick<AgentAdapter, 'setThreadName'>;
  appId: string;
  statePath: string;
  knownChats?: () => KnownChat[];
  now?: () => number;
}

/** Reuses thread/read polling; no extra Codex reader, task or prompt. */
export class CodexNameSync {
  private readonly states = new Map<string, NameState>();
  private readonly nextCheck = new Map<string, number>();
  private readonly modes = new Map<string, string>();
  private readonly retryAfter = new Map<string, number>();
  private dirty = false;

  constructor(private readonly options: CodexNameSyncOptions) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.options.statePath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.bindings)) throw new Error('Invalid name sync state');
      for (const [key, state] of data.bindings) {
        if (typeof key !== 'string' || !state || typeof state.groupName !== 'string' ||
          typeof state.threadName !== 'string') throw new Error('Invalid name sync binding');
        this.states.set(key, state);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async observe(snapshot: CodexThreadSnapshot, entries: SessionCatalogEntry[]): Promise<void> {
    if (!this.options.agent.setThreadName) return;
    const seen = new Set<string>();
    for (const entry of entries) {
      // Topic-scoped threads do not own the parent group's name. Never rename
      // another bot's group from a legacy/cross-host binding.
      if (entry.botAppId !== this.options.appId || entry.status !== 'active' ||
        entry.agentId !== 'codex' || entry.threadId !== snapshot.id ||
        !/^oc_[A-Za-z0-9]+$/.test(entry.scopeId) || seen.has(entry.scopeId)) continue;
      seen.add(entry.scopeId);
      try {
        await this.sync(entry.scopeId, snapshot);
      } catch (err) {
        this.retryAfter.set(JSON.stringify([this.options.appId, entry.scopeId, snapshot.id]),
          (this.options.now ?? Date.now)() + CHAT_CHECK_INTERVAL_MS);
        log.warn('session', 'name-sync-failed', {
          chatId: entry.scopeId, threadId: snapshot.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async sync(chatId: string, snapshot: CodexThreadSnapshot): Promise<void> {
    const key = JSON.stringify([this.options.appId, chatId, snapshot.id]);
    let state = this.states.get(key);
    const threadName = snapshot.name?.trim() ?? '';
    const now = (this.options.now ?? Date.now)();
    if (now < (this.retryAfter.get(key) ?? 0)) return;
    if (this.dirty) await this.flush();
    // Acknowledgements use the existing 2-second thread polling, even when
    // the next Feishu lookup is throttled. A subsequent rename back to the
    // original name is then a real change, not a delayed write echo.
    if (state?.previousThreadName !== undefined && threadName === state.threadName) {
      state = { ...state };
      delete state.previousThreadName;
      await this.save(key, state);
    }
    const threadChanged = state && threadName && threadName !== state.threadName &&
      threadName !== state.previousThreadName;
    if (!threadChanged && now < (this.nextCheck.get(key) ?? 0)) return;
    this.nextCheck.set(key, now + CHAT_CHECK_INTERVAL_MS);

    let mode = this.modes.get(chatId);
    if (!mode) {
      mode = await this.options.channel.getChatMode(chatId);
      this.modes.set(chatId, mode);
    }
    if (mode !== 'group') return;
    // A stale knownChats cache is not evidence of a rename. On lookup failure
    // leave the baseline untouched and retry, never overwrite either side.
    const groupName = (await this.options.channel.getChatInfo(chatId)).name?.trim();
    if (!groupName) return;

    if (!state || (groupName !== state.groupName && groupName !== state.previousGroupName)) {
      // First binding, or a new group rename: group wins this observation.
      // If both sides changed between checks, this is the deterministic tie-break.
      if (threadName !== groupName) await this.options.agent.setThreadName!(snapshot.id, groupName);
      await this.save(key, {
        groupName, threadName: groupName,
        ...(threadName !== groupName ? { previousThreadName: threadName } : {}),
      });
      log.info('session', 'thread-name-synced', { threadId: snapshot.id, name: groupName });
    } else if (threadChanged) {
      if (groupName !== threadName) await renameChat(this.options.channel, chatId, threadName);
      await this.save(key, {
        groupName: threadName, threadName,
        ...(groupName !== threadName ? { previousGroupName: groupName } : {}),
      });
      this.updateKnownChat(chatId, threadName);
      log.info('session', 'group-name-synced', { chatId, name: threadName });
    } else {
      const confirmed = { ...state };
      if (groupName === state.groupName) delete confirmed.previousGroupName;
      if (threadName === state.threadName) delete confirmed.previousThreadName;
      if (JSON.stringify(confirmed) !== JSON.stringify(state)) await this.save(key, confirmed);
    }
  }

  private updateKnownChat(chatId: string, name: string): void {
    const chat = this.options.knownChats?.().find((value) => value.id === chatId);
    if (chat) chat.name = name;
  }

  private async save(key: string, state: NameState): Promise<void> {
    this.states.set(key, state);
    this.dirty = true;
    await this.flush();
  }

  private async flush(): Promise<void> {
    await writeFileAtomic(this.options.statePath, JSON.stringify({
      version: 1, bindings: [...this.states],
    }) + '\n');
    this.dirty = false;
  }
}
