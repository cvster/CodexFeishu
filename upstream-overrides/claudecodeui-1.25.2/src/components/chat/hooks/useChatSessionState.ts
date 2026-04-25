import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { api, authenticatedFetch } from '../../../utils/api';
import { IS_CODEX_ONLY_HARDENED } from '../../../constants/config';
import type { ChatMessage, Provider } from '../types/types';
import type { Project, ProjectSession } from '../../../types/app';
import {
  loadPendingUserMessage,
  markPendingUserMessageSent,
  safeLocalStorage,
  type PendingUserMessageRecord,
} from '../utils/chatStorage';
import {
  convertCursorSessionMessages,
  convertSessionMessages,
  createCachedDiffCalculator,
  type DiffCalculator,
} from '../utils/messageTransforms';

const MESSAGES_PER_PAGE = 20;
const INITIAL_VISIBLE_MESSAGES = 100;
const MIN_REFRESHING_LATEST_MS = 500;
const SESSION_STATUS_POLL_MS = 3000;
const BOTTOM_REFRESH_GAP_PX = 12;
const BOTTOM_REFRESH_TRIGGER_DISTANCE_PX = 28;
const BOTTOM_REFRESH_TIMEOUT_MS = 1400;
const BOTTOM_REFRESH_RESET_GAP_PX = 96;

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

interface UseChatSessionStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  autoScrollToBottom?: boolean;
  externalMessageUpdate?: number;
  processingSessions?: Set<string>;
  resetStreamingState: () => void;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
}

interface ScrollRestoreState {
  height: number;
  top: number;
  mode: 'prepend' | 'preserve';
}

interface BottomRefreshGestureState {
  primed: boolean;
  startTop: number;
  startedAt: number;
}

const getRawMessageMergeKey = (message: any): string => {
  const timestamp = String(message?.timestamp || '');
  const role = String(message?.message?.role || '');
  const type = String(message?.type || 'message');
  const toolCallId = String(message?.toolCallId || message?.toolName || '');
  const contentDescriptor = Array.isArray(message?.message?.content)
    ? message.message.content
        .map((part: any) => String(part?.type || typeof part))
        .join(',')
    : typeof message?.message?.content === 'string'
      ? 'text'
      : '';

  return `${timestamp}::${role}::${type}::${toolCallId}::${contentDescriptor}`;
};

const mergeLatestSessionMessages = (
  existingMessages: any[],
  latestMessages: any[],
): { messages: any[]; addedCount: number } => {
  if (existingMessages.length === 0) {
    return {
      messages: latestMessages,
      addedCount: latestMessages.length,
    };
  }

  if (latestMessages.length === 0) {
    return {
      messages: existingMessages,
      addedCount: 0,
    };
  }

  const latestFirstKey = getRawMessageMergeKey(latestMessages[0]);
  let overlapIndex = -1;

  for (let index = existingMessages.length - 1; index >= 0; index -= 1) {
    if (getRawMessageMergeKey(existingMessages[index]) === latestFirstKey) {
      overlapIndex = index;
      break;
    }
  }

  if (overlapIndex >= 0) {
    const mergedMessages = [...existingMessages.slice(0, overlapIndex), ...latestMessages];
    return {
      messages: mergedMessages,
      addedCount: Math.max(mergedMessages.length - existingMessages.length, 0),
    };
  }

  const latestKeys = new Set(latestMessages.map((message) => getRawMessageMergeKey(message)));
  const preservedPrefix = existingMessages.filter(
    (message) => !latestKeys.has(getRawMessageMergeKey(message)),
  );
  const mergedMessages = [...preservedPrefix, ...latestMessages];

  return {
    messages: mergedMessages,
    addedCount: Math.max(mergedMessages.length - existingMessages.length, 0),
  };
};

function isPersistedChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.type !== 'string') {
    return false;
  }

  if (!('timestamp' in candidate)) {
    return false;
  }

  if ('content' in candidate && candidate.content !== undefined && typeof candidate.content !== 'string') {
    return false;
  }

  // Raw session-message payloads were previously cached during reconnects and render as blank rows.
  if ('message' in candidate && candidate.message && typeof candidate.message === 'object') {
    return false;
  }

  return true;
}

function buildChatMessagesSignature(messages: ChatMessage[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      type: message.type,
      content: message.content ?? '',
      reasoning: message.reasoning ?? '',
      timestamp:
        message.timestamp instanceof Date
          ? message.timestamp.toISOString()
          : String(message.timestamp ?? ''),
      isThinking: Boolean(message.isThinking),
      isToolUse: Boolean(message.isToolUse),
      toolName: message.toolName ?? '',
      toolId: message.toolId ?? '',
      toolCallId: message.toolCallId ?? '',
      toolInput:
        typeof message.toolInput === 'string'
          ? message.toolInput
          : JSON.stringify(message.toolInput ?? null),
      toolResult:
        message.toolResult && typeof message.toolResult === 'object'
          ? JSON.stringify(message.toolResult)
          : String(message.toolResult ?? ''),
    })),
  );
}

const normalizeUserMessageContent = (value: unknown) =>
  typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';

const getTimestampMs = (value: unknown) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const matchesPendingUserMessage = (
  message: ChatMessage,
  pendingMessage: PendingUserMessageRecord | null,
) => {
  if (!pendingMessage || message.type !== 'user') {
    return false;
  }

  const displayContent = normalizeUserMessageContent(pendingMessage.displayContent);
  const sentContent = normalizeUserMessageContent(pendingMessage.sentContent);
  if (!displayContent && !sentContent) {
    return false;
  }

  const content = normalizeUserMessageContent(message.content);
  if (!content || (content !== displayContent && content !== sentContent)) {
    return false;
  }

  const pendingTimestamp = getTimestampMs(pendingMessage.timestamp);
  const messageTimestamp = getTimestampMs(message.timestamp);
  if (pendingTimestamp === null || messageTimestamp === null) {
    return true;
  }

  const delta = messageTimestamp - pendingTimestamp;
  return delta >= -15_000;
};

const hasSyncedPendingUserMessage = (
  messages: ChatMessage[],
  pendingMessage: PendingUserMessageRecord | null,
) => {
  if (!pendingMessage) {
    return false;
  }

  const displayContent = normalizeUserMessageContent(pendingMessage.displayContent);
  const sentContent = normalizeUserMessageContent(pendingMessage.sentContent);
  if (!displayContent && !sentContent) {
    return false;
  }

  return messages.some((message) => matchesPendingUserMessage(message, pendingMessage));
};

const findLatestMatchingPendingUserMessageIndex = (
  messages: ChatMessage[],
  pendingMessage: PendingUserMessageRecord | null,
) => {
  if (!pendingMessage) {
    return -1;
  }

  const displayContent = normalizeUserMessageContent(pendingMessage.displayContent);
  const sentContent = normalizeUserMessageContent(pendingMessage.sentContent);
  if (!displayContent && !sentContent) {
    return -1;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (matchesPendingUserMessage(message, pendingMessage)) {
      return index;
    }
  }

  return -1;
};

const applyPendingUserMessage = (
  messages: ChatMessage[],
  pendingMessage: PendingUserMessageRecord | null,
) => {
  if (!pendingMessage) {
    return messages;
  }

  const matchingIndex = findLatestMatchingPendingUserMessageIndex(messages, pendingMessage);
  if (matchingIndex >= 0) {
    return messages.map((message, index) =>
      index === matchingIndex
        ? {
            ...message,
            __pendingSync: pendingMessage.status === 'sending',
            __deliveryStatus: pendingMessage.status === 'sending' ? 'sending' : 'sent',
          }
        : message,
    );
  }

  if (pendingMessage.status !== 'sending') {
    return messages;
  }

  return [
    ...messages,
    {
      type: 'user',
      content: pendingMessage.displayContent,
      timestamp: pendingMessage.timestamp,
      __pendingSync: true,
      __deliveryStatus: 'sending',
    } satisfies ChatMessage,
  ];
};

export function useChatSessionState({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  autoScrollToBottom,
  externalMessageUpdate,
  processingSessions,
  resetStreamingState,
  pendingViewSessionRef,
}: UseChatSessionStateArgs) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      const saved = safeLocalStorage.getItem(`chat_messages_${selectedProject.name}`);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as unknown;
          if (Array.isArray(parsed) && parsed.every(isPersistedChatMessage)) {
            return parsed;
          }

          safeLocalStorage.removeItem(`chat_messages_${selectedProject.name}`);
          return [];
        } catch {
          console.error('Failed to parse saved chat messages, resetting');
          safeLocalStorage.removeItem(`chat_messages_${selectedProject.name}`);
          return [];
        }
      }
      return [];
    }
    return [];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [sessionMessages, setSessionMessages] = useState<any[]>([]);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isSystemSessionChange, setIsSystemSessionChange] = useState(false);
  const [canAbortSession, setCanAbortSession] = useState(false);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [claudeStatus, setClaudeStatus] = useState<{ text: string; tokens: number; can_interrupt: boolean } | null>(null);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  const [isRefreshingLatest, setIsRefreshingLatest] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState<PendingUserMessageRecord | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  const isLoadingSessionRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  const sessionMessagesRef = useRef<any[]>([]);
  const lastLatestRefreshAtRef = useRef(0);
  const bottomRefreshGestureRef = useRef<BottomRefreshGestureState>({
    primed: false,
    startTop: 0,
    startedAt: 0,
  });

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    sessionMessagesRef.current = sessionMessages;
  }, [sessionMessages]);

  const loadSessionMessages = useCallback(
    async (projectName: string, sessionId: string, loadMore = false, provider: Provider | string = 'claude') => {
      if (!projectName || !sessionId) {
        return [] as any[];
      }

      const isInitialLoad = !loadMore;
      if (isInitialLoad) {
        setIsLoadingSessionMessages(true);
      } else {
        setIsLoadingMoreMessages(true);
      }

      try {
        const currentOffset = loadMore ? messagesOffsetRef.current : 0;
        const response = await (api.sessionMessages as any)(
          projectName,
          sessionId,
          MESSAGES_PER_PAGE,
          currentOffset,
          provider,
        );
        if (response.status === 304) {
          return isInitialLoad ? sessionMessagesRef.current : [];
        }

        if (!response.ok) {
          throw new Error('Failed to load session messages');
        }

        const data = await response.json();
        if (isInitialLoad && data.tokenUsage) {
          setTokenBudget(data.tokenUsage);
        }

        if (data.hasMore !== undefined) {
          const loadedCount = data.messages?.length || 0;
          setHasMoreMessages(Boolean(data.hasMore));
          setTotalMessages(Number(data.total || 0));
          messagesOffsetRef.current = currentOffset + loadedCount;
          return data.messages || [];
        }

        const messages = data.messages || [];
        setHasMoreMessages(false);
        setTotalMessages(messages.length);
        messagesOffsetRef.current = messages.length;
        return messages;
      } catch (error) {
        console.error('Error loading session messages:', error);
        return isInitialLoad ? sessionMessagesRef.current : [];
      } finally {
        if (isInitialLoad) {
          setIsLoadingSessionMessages(false);
        } else {
          setIsLoadingMoreMessages(false);
        }
      }
    },
    [],
  );

  const loadCursorSessionMessages = useCallback(async (projectPath: string, sessionId: string) => {
    if (!projectPath || !sessionId) {
      return [] as ChatMessage[];
    }

    setIsLoadingSessionMessages(true);
    try {
      const url = `/api/cursor/sessions/${encodeURIComponent(sessionId)}?projectPath=${encodeURIComponent(projectPath)}`;
      const response = await authenticatedFetch(url);
      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      const blobs = (data?.session?.messages || []) as any[];
      return convertCursorSessionMessages(blobs, projectPath);
    } catch (error) {
      console.error('Error loading Cursor session messages:', error);
      return [];
    } finally {
      setIsLoadingSessionMessages(false);
    }
  }, []);

  const resolvedSessionProvider = useMemo(
    () =>
      (selectedSession?.__provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude')) as Provider,
    [selectedSession?.__provider],
  );

  useEffect(() => {
    if (!selectedProject || !selectedSession?.id) {
      setPendingUserMessage(null);
      return;
    }

    setPendingUserMessage(
      loadPendingUserMessage(selectedProject.name, selectedSession.id, resolvedSessionProvider),
    );
  }, [resolvedSessionProvider, selectedProject?.name, selectedSession?.id]);

  const baseConvertedMessages = useMemo(() => {
    return convertSessionMessages(sessionMessages);
  }, [sessionMessages]);

  const convertedMessages = useMemo(() => {
    return applyPendingUserMessage(baseConvertedMessages, pendingUserMessage);
  }, [baseConvertedMessages, pendingUserMessage]);
  const convertedMessagesSignature = useMemo(
    () => buildChatMessagesSignature(convertedMessages),
    [convertedMessages],
  );

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, []);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return false;
    }
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) {
        return false;
      }
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) {
        return false;
      }

      const sessionProvider = selectedSession.__provider || 'claude';
      if (sessionProvider === 'cursor') {
        return false;
      }

      isLoadingMoreRef.current = true;
      const previousScrollHeight = container.scrollHeight;
      const previousScrollTop = container.scrollTop;

      try {
        const moreMessages = await loadSessionMessages(
          selectedProject.name,
          selectedSession.id,
          true,
          sessionProvider,
        );

        if (moreMessages.length === 0) {
          return false;
        }

        pendingScrollRestoreRef.current = {
          height: previousScrollHeight,
          top: previousScrollTop,
          mode: 'prepend',
        };
        setSessionMessages((previous) => [...moreMessages, ...previous]);
        // Keep the rendered window in sync with top-pagination so newly loaded history becomes visible.
        setVisibleMessageCount((previousCount) => previousCount + moreMessages.length);
        return true;
      } finally {
        isLoadingMoreRef.current = false;
      }
    },
    [hasMoreMessages, isLoadingMoreMessages, loadSessionMessages, selectedProject, selectedSession],
  );

  const refreshLatestMessages = useCallback(
    async ({ preserveScroll = false }: { preserveScroll?: boolean } = {}) => {
      if (!selectedSession || !selectedProject) {
        return false;
      }

      const sessionProvider = (selectedSession.__provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude')) as Provider;
      const refreshStartedAt = Date.now();

      setIsRefreshingLatest(true);
      try {
        if (sessionProvider === 'cursor') {
          const projectPath = selectedProject.fullPath || selectedProject.path || '';
          const converted = await loadCursorSessionMessages(projectPath, selectedSession.id);
          setSessionMessages([]);
          setChatMessages(converted);
          sendMessage({
            type: 'check-session-status',
            sessionId: selectedSession.id,
            provider: sessionProvider,
          });
          return true;
        }

        const container = scrollContainerRef.current;
        const response = await (api.sessionMessages as any)(
          selectedProject.name,
          selectedSession.id,
          MESSAGES_PER_PAGE,
          0,
          sessionProvider,
        );

        if (!response.ok) {
          throw new Error('Failed to refresh latest session messages');
        }

        const data = await response.json();
        const latestMessages = data.messages || [];
        const { messages: mergedMessages, addedCount } = mergeLatestSessionMessages(
          sessionMessagesRef.current,
          latestMessages,
        );
        const total = Number(data.total || mergedMessages.length);
        const convertedMergedMessages = convertSessionMessages(mergedMessages);
        const nextPendingUserMessage =
          pendingUserMessage && hasSyncedPendingUserMessage(convertedMergedMessages, pendingUserMessage)
            ? markPendingUserMessageSent(
                selectedProject.name,
                selectedSession.id,
                sessionProvider,
              )
            : pendingUserMessage;
        const renderedMessages = applyPendingUserMessage(convertedMergedMessages, nextPendingUserMessage);

        if (preserveScroll && container) {
          pendingScrollRestoreRef.current = {
            height: container.scrollHeight,
            top: container.scrollTop,
            mode: 'preserve',
          };
        }

        setSessionMessages(mergedMessages);
        if (nextPendingUserMessage !== pendingUserMessage) {
          setPendingUserMessage(nextPendingUserMessage);
        }
        setChatMessages(renderedMessages);
        prevConvertedMessagesSignatureRef.current = buildChatMessagesSignature(renderedMessages);
        setTotalMessages(total);
        setHasMoreMessages(mergedMessages.length < total);
        messagesOffsetRef.current += addedCount;

        if (data.tokenUsage) {
          setTokenBudget(data.tokenUsage);
        }

        sendMessage({
          type: 'check-session-status',
          sessionId: selectedSession.id,
          provider: sessionProvider,
        });

        return addedCount > 0;
      } catch (error) {
        console.error('Error refreshing latest session messages:', error);
        return false;
      } finally {
        const elapsed = Date.now() - refreshStartedAt;
        if (elapsed < MIN_REFRESHING_LATEST_MS) {
          await new Promise((resolve) => setTimeout(resolve, MIN_REFRESHING_LATEST_MS - elapsed));
        }
        setIsRefreshingLatest(false);
      }
    },
    [loadCursorSessionMessages, pendingUserMessage, selectedProject, selectedSession, sendMessage, setChatMessages],
  );

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const now = Date.now();
    const bottomGap = Math.max(container.scrollHeight - container.scrollTop - container.clientHeight, 0);
    const nearBottom = isNearBottom();
    setIsUserScrolledUp(!nearBottom);

    const bottomRefreshGesture = bottomRefreshGestureRef.current;
    if (bottomGap <= BOTTOM_REFRESH_GAP_PX) {
      if (!bottomRefreshGesture.primed || container.scrollTop > bottomRefreshGesture.startTop) {
        bottomRefreshGesture.primed = true;
        bottomRefreshGesture.startTop = container.scrollTop;
        bottomRefreshGesture.startedAt = now;
      }
    } else if (
      bottomRefreshGesture.primed &&
      !isRefreshingLatest &&
      bottomRefreshGesture.startTop - container.scrollTop >= BOTTOM_REFRESH_TRIGGER_DISTANCE_PX &&
      now - bottomRefreshGesture.startedAt <= BOTTOM_REFRESH_TIMEOUT_MS &&
      now - lastLatestRefreshAtRef.current > 1200
    ) {
      bottomRefreshGesture.primed = false;
      lastLatestRefreshAtRef.current = now;
      await refreshLatestMessages({ preserveScroll: true });
      return;
    } else if (
      bottomRefreshGesture.primed &&
      (bottomGap >= BOTTOM_REFRESH_RESET_GAP_PX || now - bottomRefreshGesture.startedAt > BOTTOM_REFRESH_TIMEOUT_MS)
    ) {
      bottomRefreshGesture.primed = false;
    }

    if (!allMessagesLoadedRef.current) {
      const scrolledNearTop = container.scrollTop < 100;
      if (!scrolledNearTop) {
        topLoadLockRef.current = false;
        return;
      }

      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) {
          topLoadLockRef.current = false;
        }
        return;
      }

      const activeProjectName = selectedProject?.name;
      const activeSessionId = selectedSession?.id;
      const activeProvider = selectedSession?.__provider || 'claude';
      const shouldRefreshLatestFirst =
        Boolean(activeProjectName && activeSessionId) &&
        activeProvider !== 'cursor' &&
        now - lastLatestRefreshAtRef.current > 3000;

      if (shouldRefreshLatestFirst) {
        lastLatestRefreshAtRef.current = now;
        const didSyncLatest = await refreshLatestMessages({ preserveScroll: true });
        if (didSyncLatest) {
          topLoadLockRef.current = true;
          return;
        }
      }

      const didLoad = await loadOlderMessages(container);
      if (didLoad) {
        topLoadLockRef.current = true;
      }
    }
  }, [isNearBottom, loadOlderMessages, refreshLatestMessages, selectedProject?.name, selectedSession?.__provider, selectedSession?.id]);

  useLayoutEffect(() => {
    if (!pendingScrollRestoreRef.current || !scrollContainerRef.current) {
      return;
    }

    const { height, top, mode } = pendingScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    const newScrollHeight = container.scrollHeight;
    const scrollDiff = newScrollHeight - height;
    container.scrollTop = mode === 'prepend' ? top + Math.max(scrollDiff, 0) : top;
    pendingScrollRestoreRef.current = null;
  }, [chatMessages.length]);

  const prevConvertedMessagesSignatureRef = useRef('');

  useEffect(() => {
    if (!searchScrollActiveRef.current) {
      pendingInitialScrollRef.current = true;
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    }
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    prevConvertedMessagesSignatureRef.current = '';
    setIsUserScrolledUp(false);
    lastLatestRefreshAtRef.current = 0;
    bottomRefreshGestureRef.current = {
      primed: false,
      startTop: 0,
      startedAt: 0,
    };
  }, [selectedProject?.name, selectedSession?.id]);

  useEffect(() => {
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) {
      return;
    }

    if (chatMessages.length === 0) {
      pendingInitialScrollRef.current = false;
      return;
    }

    pendingInitialScrollRef.current = false;
    if (!searchScrollActiveRef.current) {
      setTimeout(() => {
        scrollToBottom();
      }, 200);
    }
  }, [chatMessages.length, isLoadingSessionMessages, scrollToBottom]);

  useEffect(() => {
    const loadMessages = async () => {
      if (selectedSession && selectedProject) {
        const provider = (selectedSession.__provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude')) as Provider;
        isLoadingSessionRef.current = true;

        const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSession.id;
        if (sessionChanged) {
          if (!isSystemSessionChange) {
            resetStreamingState();
            pendingViewSessionRef.current = null;
            setChatMessages([]);
            setSessionMessages([]);
            setClaudeStatus(null);
            setCanAbortSession(false);
          }

          messagesOffsetRef.current = 0;
          setHasMoreMessages(false);
          setTotalMessages(0);
          setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
          setAllMessagesLoaded(false);
          allMessagesLoadedRef.current = false;
          setIsLoadingAllMessages(false);
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
          if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
          setTokenBudget(null);
          setIsLoading(false);

          if (ws) {
            sendMessage({
              type: 'check-session-status',
              sessionId: selectedSession.id,
              provider,
            });
          }
        } else if (currentSessionId === null) {
          messagesOffsetRef.current = 0;
          setHasMoreMessages(false);
          setTotalMessages(0);

          if (ws) {
            sendMessage({
              type: 'check-session-status',
              sessionId: selectedSession.id,
              provider,
            });
          }
        }

        // Skip loading if session+project+provider hasn't changed
        const sessionKey = `${selectedSession.id}:${selectedProject.name}:${provider}`;
        if (lastLoadedSessionKeyRef.current === sessionKey) {
          setTimeout(() => {
            isLoadingSessionRef.current = false;
          }, 250);
          return;
        }

        if (provider === 'cursor') {
          setCurrentSessionId(selectedSession.id);
          sessionStorage.setItem('cursorSessionId', selectedSession.id);

          if (!isSystemSessionChange) {
            const projectPath = selectedProject.fullPath || selectedProject.path || '';
            const converted = await loadCursorSessionMessages(projectPath, selectedSession.id);
            if (pendingUserMessage && hasSyncedPendingUserMessage(converted, pendingUserMessage)) {
              setPendingUserMessage(
                markPendingUserMessageSent(
                  selectedProject.name,
                  selectedSession.id,
                  resolvedSessionProvider,
                ),
              );
            }
            setSessionMessages([]);
            setChatMessages(applyPendingUserMessage(converted, pendingUserMessage));
          } else {
            setIsSystemSessionChange(false);
          }
        } else {
          setCurrentSessionId(selectedSession.id);

          if (!isSystemSessionChange) {
            const messages = await loadSessionMessages(
              selectedProject.name,
              selectedSession.id,
              false,
              selectedSession.__provider || 'claude',
            );
            setSessionMessages(messages);
          } else {
            setIsSystemSessionChange(false);
          }
        }

        // Update the last loaded session key
        lastLoadedSessionKeyRef.current = sessionKey;
      } else {
        if (!isSystemSessionChange) {
          resetStreamingState();
          pendingViewSessionRef.current = null;
          setChatMessages([]);
          setSessionMessages([]);
          setClaudeStatus(null);
          setCanAbortSession(false);
          setIsLoading(false);
        }

        setCurrentSessionId(null);
        sessionStorage.removeItem('cursorSessionId');
        messagesOffsetRef.current = 0;
        setHasMoreMessages(false);
        setTotalMessages(0);
        setTokenBudget(null);
        lastLoadedSessionKeyRef.current = null;
      }

      setTimeout(() => {
        isLoadingSessionRef.current = false;
      }, 250);
    };

    loadMessages();
  }, [
    // Intentionally exclude currentSessionId: this effect sets it and should not retrigger another full load.
    isSystemSessionChange,
    loadCursorSessionMessages,
    loadSessionMessages,
    pendingUserMessage,
    pendingViewSessionRef,
    resetStreamingState,
    resolvedSessionProvider,
    selectedProject,
    selectedSession?.id, // Only depend on session ID, not the entire object
    sendMessage,
    ws,
  ]);

  useEffect(() => {
    if (!ws || !selectedSession || !selectedProject) {
      return;
    }

    const provider = (selectedSession.__provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude')) as Provider;
    if (provider !== 'codex') {
      return;
    }

    const requestSessionStatus = () => {
      sendMessage({
        type: 'check-session-status',
        sessionId: selectedSession.id,
        provider,
      });
    };

    requestSessionStatus();
    const intervalId = window.setInterval(requestSessionStatus, SESSION_STATUS_POLL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [selectedProject, selectedSession, sendMessage, ws]);

  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) {
      return;
    }

    const reloadExternalMessages = async () => {
      try {
        const provider = (selectedSession.__provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude')) as Provider;

        if (provider === 'cursor') {
          const projectPath = selectedProject.fullPath || selectedProject.path || '';
          const converted = await loadCursorSessionMessages(projectPath, selectedSession.id);
          if (pendingUserMessage && hasSyncedPendingUserMessage(converted, pendingUserMessage)) {
            setPendingUserMessage(
              markPendingUserMessageSent(
                selectedProject.name,
                selectedSession.id,
                resolvedSessionProvider,
              ),
            );
          }
          setSessionMessages([]);
          setChatMessages(applyPendingUserMessage(converted, pendingUserMessage));
          return;
        }

        await refreshLatestMessages({ preserveScroll: isUserScrolledUp });

        const shouldAutoScroll = Boolean(autoScrollToBottom) && isNearBottom();
        if (shouldAutoScroll) {
          setTimeout(() => scrollToBottom(), 200);
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    autoScrollToBottom,
    externalMessageUpdate,
    isNearBottom,
    isUserScrolledUp,
    loadCursorSessionMessages,
    pendingUserMessage,
    refreshLatestMessages,
    resolvedSessionProvider,
    scrollToBottom,
    selectedProject,
    selectedSession,
  ]);

  // Detect search navigation target from selectedSession object reference change
  // This must be a separate effect because the loading effect depends on selectedSession?.id
  // which doesn't change when clicking a search result for the already-loaded session
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  useEffect(() => {
    if (selectedSession?.id) {
      pendingViewSessionRef.current = null;
    }
  }, [pendingViewSessionRef, selectedSession?.id]);

  useEffect(() => {
    if (
      !selectedProject ||
      !selectedSession?.id ||
      !pendingUserMessage ||
      pendingUserMessage.status === 'sent'
    ) {
      return;
    }

    if (!hasSyncedPendingUserMessage(baseConvertedMessages, pendingUserMessage)) {
      return;
    }

    setPendingUserMessage(
      markPendingUserMessageSent(selectedProject.name, selectedSession.id, resolvedSessionProvider),
    );
  }, [
    baseConvertedMessages,
    pendingUserMessage,
    resolvedSessionProvider,
    selectedProject,
    selectedSession?.id,
  ]);

  useEffect(() => {
    // Keep the rendered chat in sync with sessionMessages whenever the actual content changes.
    // This allows Codex replies that grow in-place to repaint even if the message count is unchanged.
    if (
      isLoading &&
      chatMessages.length > 0 &&
      convertedMessages.length <= chatMessages.length
    ) {
      return;
    }

    if (convertedMessagesSignature === prevConvertedMessagesSignatureRef.current) {
      return;
    }

    setChatMessages(convertedMessages);
    prevConvertedMessagesSignatureRef.current = convertedMessagesSignature;
  }, [chatMessages.length, convertedMessages, convertedMessagesSignature, isLoading, setChatMessages]);

  useEffect(() => {
    if (selectedProject && chatMessages.length > 0) {
      safeLocalStorage.setItem(`chat_messages_${selectedProject.name}`, JSON.stringify(chatMessages));
    }
  }, [chatMessages, selectedProject]);

  // Scroll to search target message after messages are loaded
  useEffect(() => {
    if (!searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    // Clear immediately to prevent re-triggering
    setSearchTarget(null);

    const scrollToTarget = async () => {
      // Always load all messages when navigating from search
      // (hasMoreMessages may not be set yet due to race with loading effect)
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
        const sessionProvider = selectedSession.__provider || 'claude';
        if (sessionProvider !== 'cursor') {
          try {
            const response = await (api.sessionMessages as any)(
              selectedProject.name,
              selectedSession.id,
              null,
              0,
              sessionProvider,
            );
            if (response.ok) {
              const data = await response.json();
              const allMessages = data.messages || data;
              setSessionMessages(Array.isArray(allMessages) ? allMessages : []);
              setHasMoreMessages(false);
              setTotalMessages(Array.isArray(allMessages) ? allMessages.length : 0);
              messagesOffsetRef.current = Array.isArray(allMessages) ? allMessages.length : 0;
              setVisibleMessageCount(Infinity);
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
              // Wait for messages to render after state update
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch {
            // Fall through and scroll in current messages
          }
        }
      }
      setVisibleMessageCount(Infinity);

      // Retry finding the element in the DOM until React finishes rendering all messages
      const findAndScroll = (retriesLeft: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;

        let targetElement: Element | null = null;

        // Match by snippet text content (most reliable)
        if (target.snippet) {
          const cleanSnippet = target.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
          // Use a contiguous substring from the snippet (don't filter words, it breaks matching)
          const searchPhrase = cleanSnippet.slice(0, 80).toLowerCase().trim();

          if (searchPhrase.length >= 10) {
            const messageElements = container.querySelectorAll('.chat-message');
            for (const el of messageElements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes(searchPhrase)) {
                targetElement = el;
                break;
              }
            }
          }
        }

        // Fallback to timestamp matching
        if (!targetElement && target.timestamp) {
          const targetDate = new Date(target.timestamp).getTime();
          const messageElements = container.querySelectorAll('[data-message-timestamp]');
          let closestDiff = Infinity;

          for (const el of messageElements) {
            const ts = el.getAttribute('data-message-timestamp');
            if (!ts) continue;
            const diff = Math.abs(new Date(ts).getTime() - targetDate);
            if (diff < closestDiff) {
              closestDiff = diff;
              targetElement = el;
            }
          }
        }

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement?.classList.remove('search-highlight-flash'), 4000);
          searchScrollActiveRef.current = false;
        } else if (retriesLeft > 0) {
          setTimeout(() => findAndScroll(retriesLeft - 1), 200);
        } else {
          searchScrollActiveRef.current = false;
        }
      };

      // Start polling after a short delay to let React begin rendering
      setTimeout(() => findAndScroll(15), 150);
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isLoadingSessionMessages, searchTarget]);

  useEffect(() => {
    if (!selectedProject || !selectedSession?.id || selectedSession.id.startsWith('new-session-')) {
      setTokenBudget(null);
      return;
    }

    const sessionProvider = selectedSession.__provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude');

    const fetchInitialTokenUsage = async () => {
      try {
        const params = new URLSearchParams({ provider: sessionProvider });
        const url = `/api/projects/${selectedProject.name}/sessions/${selectedSession.id}/token-usage?${params.toString()}`;
        const response = await authenticatedFetch(url);
        if (response.status === 304) {
          return;
        }

        if (response.ok) {
          const data = await response.json();
          setTokenBudget(data);
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };

    fetchInitialTokenUsage();
  }, [selectedProject, selectedSession?.id, selectedSession?.__provider]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) {
      return chatMessages;
    }
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  useEffect(() => {
    if (!autoScrollToBottom && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      scrollPositionRef.current = {
        height: container.scrollHeight,
        top: container.scrollTop,
      };
    }
  });

  useEffect(() => {
    if (!scrollContainerRef.current || chatMessages.length === 0) {
      return;
    }

    if (isLoadingMoreRef.current || isLoadingMoreMessages || pendingScrollRestoreRef.current) {
      return;
    }

    if (searchScrollActiveRef.current) {
      return;
    }

    if (autoScrollToBottom) {
      if (!isUserScrolledUp) {
        setTimeout(() => scrollToBottom(), 50);
      }
      return;
    }

    const container = scrollContainerRef.current;
    const prevHeight = scrollPositionRef.current.height;
    const prevTop = scrollPositionRef.current.top;
    const newHeight = container.scrollHeight;
    const heightDiff = newHeight - prevHeight;

    if (heightDiff > 0 && prevTop > 0) {
      container.scrollTop = prevTop + heightDiff;
    }
  }, [autoScrollToBottom, chatMessages.length, isLoadingMoreMessages, isUserScrolledUp, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    const activeViewSessionId = selectedSession?.id || currentSessionId;
    if (!activeViewSessionId || !processingSessions) {
      return;
    }

    const shouldBeProcessing = processingSessions.has(activeViewSessionId);
    if (shouldBeProcessing && !isLoading) {
      setIsLoading(true);
      setCanAbortSession(true);
    }
  }, [currentSessionId, isLoading, processingSessions, selectedSession?.id]);

  // Show "Load all" overlay after a batch finishes loading, persist for 2s then hide
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoadingMoreMessages;

    if (wasLoading && !isLoadingMoreMessages && hasMoreMessages) {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      setShowLoadAllOverlay(true);
      loadAllOverlayTimerRef.current = setTimeout(() => {
        setShowLoadAllOverlay(false);
      }, 2000);
    }
    if (!hasMoreMessages && !isLoadingMoreMessages) {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      setShowLoadAllOverlay(false);
    }
    return () => {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    };
  }, [isLoadingMoreMessages, hasMoreMessages]);

  const loadAllMessages = useCallback(async () => {
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const sessionProvider = selectedSession.__provider || 'claude';
    if (sessionProvider === 'cursor') {
      setVisibleMessageCount(Infinity);
      setAllMessagesLoaded(true);
      allMessagesLoadedRef.current = true;
      setLoadAllJustFinished(true);
      if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = setTimeout(() => {
        setLoadAllJustFinished(false);
        setShowLoadAllOverlay(false);
      }, 1000);
      return;
    }

    const requestSessionId = selectedSession.id;

    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);

    const container = scrollContainerRef.current;
    const previousScrollHeight = container ? container.scrollHeight : 0;
    const previousScrollTop = container ? container.scrollTop : 0;

    try {
      const response = await (api.sessionMessages as any)(
        selectedProject.name,
        requestSessionId,
        null,
        0,
        sessionProvider,
      );

      if (currentSessionId !== requestSessionId) return;

      if (response.ok) {
        const data = await response.json();
        const allMessages = data.messages || data;

        if (container) {
          pendingScrollRestoreRef.current = {
            height: previousScrollHeight,
            top: previousScrollTop,
            mode: 'prepend',
          };
        }

        setSessionMessages(Array.isArray(allMessages) ? allMessages : []);
        setHasMoreMessages(false);
        setTotalMessages(Array.isArray(allMessages) ? allMessages.length : 0);
        messagesOffsetRef.current = Array.isArray(allMessages) ? allMessages.length : 0;

        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
        }, 1000);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [selectedSession, selectedProject, isLoadingAllMessages, currentSessionId]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((previousCount) => previousCount + 100);
  }, []);

  return {
    chatMessages,
    setChatMessages,
    isLoading,
    setIsLoading,
    currentSessionId,
    setCurrentSessionId,
    sessionMessages,
    setSessionMessages,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isSystemSessionChange,
    setIsSystemSessionChange,
    canAbortSession,
    setCanAbortSession,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    isRefreshingLatest,
    pendingUserMessage,
    setPendingUserMessage,
    claudeStatus,
    setClaudeStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
    refreshLatestMessages,
    loadSessionMessages,
    loadCursorSessionMessages,
  };
}
