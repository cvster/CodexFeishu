import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { cn } from '../../../../lib/utils';
import { api } from '../../../../utils/api';
import {
  loadPendingUserMessage,
  markPendingUserMessageFailed,
  markPendingUserMessageSent,
  PENDING_USER_MESSAGE_CHANGED_EVENT,
  type PendingUserMessageChangedEventDetail,
  type PendingUserMessageRecord,
} from '../../../chat/utils/chatStorage';
import type { SessionWithProvider } from '../../types/types';

const PENDING_DELIVERY_CHECK_INTERVAL_MS = 3000;

type ProjectSidebarStatus = 'sending' | 'failed' | 'replying' | 'completed';

type SidebarProjectStatusBadgeProps = {
  projectName: string;
  sessions: SessionWithProvider[];
  processingSessions: Set<string>;
  className?: string;
  t: TFunction;
};

const isPendingUserMessageRecord = (
  pendingMessage: PendingUserMessageRecord | null,
): pendingMessage is PendingUserMessageRecord => Boolean(pendingMessage);

const getStatusClassName = (status: ProjectSidebarStatus) =>
  status === 'failed'
    ? 'border-red-500/40 bg-red-500/10 text-red-500'
    : status === 'replying'
      ? 'border-sky-500/40 bg-sky-500/10 text-sky-500'
      : status === 'sending'
        ? 'border-orange-400/40 bg-orange-500/10 text-orange-500'
        : 'border-green-500/30 bg-green-500/10 text-green-600';

export default function SidebarProjectStatusBadge({
  projectName,
  sessions,
  processingSessions,
  className,
  t,
}: SidebarProjectStatusBadgeProps) {
  const [statusVersion, setStatusVersion] = useState(0);

  const refreshStatus = useCallback(() => {
    setStatusVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    const handlePendingChange = (event: Event) => {
      const detail = (event as CustomEvent<PendingUserMessageChangedEventDetail>).detail;
      if (detail?.projectName === projectName) {
        refreshStatus();
      }
    };

    window.addEventListener(PENDING_USER_MESSAGE_CHANGED_EVENT, handlePendingChange);
    window.addEventListener('storage', refreshStatus);

    return () => {
      window.removeEventListener(PENDING_USER_MESSAGE_CHANGED_EVENT, handlePendingChange);
      window.removeEventListener('storage', refreshStatus);
    };
  }, [projectName, refreshStatus]);

  const pendingMessages = useMemo(
    () =>
      sessions
        .map((session) => loadPendingUserMessage(projectName, session.id, session.__provider))
        .filter(isPendingUserMessageRecord),
    [projectName, sessions, statusVersion],
  );

  const checkPendingDelivery = useCallback(async () => {
    await Promise.all(
      pendingMessages
        .filter((pendingMessage) => pendingMessage.status !== 'sent' && pendingMessage.provider === 'codex')
        .map(async (pendingMessage) => {
          try {
            const response = await (api.codexPendingDelivery as any)(
              pendingMessage.sessionId,
              {
                displayContent: pendingMessage.displayContent,
                sentContent: pendingMessage.sentContent,
                timestamp: pendingMessage.timestamp,
              },
            );

            if (!response.ok) {
              return;
            }

            const data = await response.json();
            if (data?.pendingDelivery?.status === 'sent') {
              markPendingUserMessageSent(projectName, pendingMessage.sessionId, pendingMessage.provider);
            } else if (data?.pendingDelivery?.status === 'failed') {
              markPendingUserMessageFailed(projectName, pendingMessage.sessionId, pendingMessage.provider);
            }
          } catch (error) {
            console.error('Error checking project sidebar Codex pending delivery:', error);
          }
        }),
    );
  }, [pendingMessages, projectName]);

  useEffect(() => {
    if (!pendingMessages.some((pendingMessage) => pendingMessage.status === 'sending')) {
      return;
    }

    void checkPendingDelivery();
    const intervalId = window.setInterval(() => {
      void checkPendingDelivery();
    }, PENDING_DELIVERY_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [checkPendingDelivery, pendingMessages]);

  useEffect(() => {
    if (!pendingMessages.some((pendingMessage) => pendingMessage.status === 'failed')) {
      return;
    }

    void checkPendingDelivery();
  }, [checkPendingDelivery, pendingMessages]);

  const status: ProjectSidebarStatus | null = pendingMessages.some((pendingMessage) => pendingMessage.status === 'failed')
    ? 'failed'
    : pendingMessages.some((pendingMessage) => pendingMessage.status === 'sending')
      ? 'sending'
      : sessions.some((session) => processingSessions.has(session.id))
        ? 'replying'
        : sessions.length > 0
          ? 'completed'
          : null;

  if (!status) {
    return null;
  }

  const label =
    status === 'sending'
      ? t('deliveryStatus.sending', { defaultValue: '发送中' })
      : status === 'failed'
        ? t('deliveryStatus.failed', { defaultValue: '发送失败' })
        : status === 'replying'
          ? t('deliveryStatus.replying', { defaultValue: '回复中' })
          : t('common:status.completed');

  return (
    <div
      className={cn(
        'inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border transition-colors',
        getStatusClassName(status),
        className,
      )}
      title={label}
      aria-label={label}
      role="status"
    >
      {status === 'failed' ? (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M12 8v5" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M12 17h.01" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
      ) : status === 'replying' ? (
        <svg className="h-3.5 w-3.5 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M4 12h6" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M14 12h6" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 4v6" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 14v6" />
        </svg>
      ) : status === 'sending' ? (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M5 12h11" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M13 8l4 4-4 4" />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M7 12.5l3.2 3.2L17 9" />
        </svg>
      )}
    </div>
  );
}
