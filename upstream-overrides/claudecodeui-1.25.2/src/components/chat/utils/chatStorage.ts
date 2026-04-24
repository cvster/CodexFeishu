import type { ClaudeSettings } from '../types/types';

export const CLAUDE_SETTINGS_KEY = 'claude-settings';

export interface PendingUserMessageRecord {
  sessionId: string;
  provider: string;
  displayContent: string;
  sentContent: string;
  timestamp: string;
}

const PENDING_USER_MESSAGE_PREFIX = 'pending_user_message_';

const getPendingUserMessageStorageKey = (
  projectName: string,
  sessionId: string,
  provider: string,
) =>
  `${PENDING_USER_MESSAGE_PREFIX}${encodeURIComponent(projectName)}_${encodeURIComponent(
    provider,
  )}_${encodeURIComponent(sessionId)}`;

const isPendingUserMessageRecord = (value: unknown): value is PendingUserMessageRecord => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionId === 'string' &&
    typeof candidate.provider === 'string' &&
    typeof candidate.displayContent === 'string' &&
    typeof candidate.sentContent === 'string' &&
    typeof candidate.timestamp === 'string'
  );
};

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      if (key.startsWith('chat_messages_') && typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed) && parsed.length > 50) {
            const truncated = parsed.slice(-50);
            value = JSON.stringify(truncated);
          }
        } catch (parseError) {
          console.warn('Could not parse chat messages for truncation:', parseError);
        }
      }

      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old data');

        const keys = Object.keys(localStorage);
        const chatKeys = keys.filter((k) => k.startsWith('chat_messages_')).sort();

        if (chatKeys.length > 3) {
          chatKeys.slice(0, chatKeys.length - 3).forEach((k) => {
            localStorage.removeItem(k);
          });
        }

        const draftKeys = keys.filter((k) => k.startsWith('draft_input_'));
        draftKeys.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
          if (key.startsWith('chat_messages_') && typeof value === 'string') {
            try {
              const parsed = JSON.parse(value);
              if (Array.isArray(parsed) && parsed.length > 10) {
                const minimal = parsed.slice(-10);
                localStorage.setItem(key, JSON.stringify(minimal));
              }
            } catch (finalError) {
              console.error('Final save attempt failed:', finalError);
            }
          }
        }
      } else {
        console.error('localStorage error:', error);
      }
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
};

export const savePendingUserMessage = (
  projectName: string,
  sessionId: string,
  provider: string,
  message: Omit<PendingUserMessageRecord, 'sessionId' | 'provider'>,
) => {
  safeLocalStorage.setItem(
    getPendingUserMessageStorageKey(projectName, sessionId, provider),
    JSON.stringify({
      sessionId,
      provider,
      displayContent: message.displayContent,
      sentContent: message.sentContent,
      timestamp: message.timestamp,
    } satisfies PendingUserMessageRecord),
  );
};

export const loadPendingUserMessage = (
  projectName: string,
  sessionId: string,
  provider: string,
): PendingUserMessageRecord | null => {
  const raw = safeLocalStorage.getItem(
    getPendingUserMessageStorageKey(projectName, sessionId, provider),
  );
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isPendingUserMessageRecord(parsed)) {
      return parsed;
    }
  } catch (error) {
    console.error('Failed to parse pending user message:', error);
  }

  safeLocalStorage.removeItem(getPendingUserMessageStorageKey(projectName, sessionId, provider));
  return null;
};

export const clearPendingUserMessage = (
  projectName: string,
  sessionId: string,
  provider: string,
) => {
  safeLocalStorage.removeItem(getPendingUserMessageStorageKey(projectName, sessionId, provider));
};

export function getClaudeSettings(): ClaudeSettings {
  const raw = safeLocalStorage.getItem(CLAUDE_SETTINGS_KEY);
  if (!raw) {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      skipPermissions: Boolean(parsed.skipPermissions),
      projectSortOrder: parsed.projectSortOrder || 'name',
    };
  } catch {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }
}
