import { useCallback, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { cn } from '../../../../lib/utils';
import { api } from '../../../../utils/api';
import type { SessionProvider } from '../../../../types/app';
import {
  loadPendingUserMessage,
  markPendingUserMessageFailed,
  markPendingUserMessageSent,
  PENDING_USER_MESSAGE_CHANGED_EVENT,
  type PendingUserMessageChangedEventDetail,
  type PendingUserMessageRecord,
} from '../../../chat/utils/chatStorage';

const PENDING_DELIVERY_CHECK_INTERVAL_MS = 3000;

type SidebarSessionStatus = 'sending' | 'failed' | 'replying' | 'completed';

type SidebarSessionStatusBadgeProps = {
  projectName: string;
  sessionId: string;
  provider: SessionProvider;
  isProcessing: boolean;
  showCompleted: boolean;
  className?: string;
  t: TFunction;
};

const getPendingStatus = (
  projectName: string,
  sessionId: string,
  provider: SessionProvider,
): PendingUserMessageRecord['status'] | null =>
  loadPendingUserMessage(projectName, sessionId, provider)?.status ?? null;

const getSidebarStatus = (
  pendingStatus: PendingUserMessageRecord['status'] | null,
  isProcessing: boolean,
  showCompleted: boolean,
): SidebarSessionStatus | null => {
  if (pendingStatus === 'sending') {
    return 'sending';
  }

  if (pendingStatus === 'failed') {
    return 'failed';
  }

  if (isProcessing) {
    return 'replying';
  }

  return showCompleted ? 'completed' : null;
};

const getStatusClassName = (status: SidebarSessionStatus) =>
  status === 'failed'
    ? 'border-red-500/40 bg-red-500/10 text-red-500'
    : status === 'replying'
      ? 'border-sky-500/40 bg-sky-500/10 text-sky-500'
      : status === 'sending'
        ? 'border-orange-400/40 bg-orange-500/10 text-orange-500'
        : 'border-green-500/30 bg-green-500/10 text-green-600';

export default function SidebarSessionStatusBadge({
  projectName,
  sessionId,
  provider,
  isProcessing,
  showCompleted,
  className,
  t,
}: SidebarSessionStatusBadgeProps) {
  const [pendingStatus, setPendingStatus] = useState<PendingUserMessageRecord['status'] | null>(() =>
    getPendingStatus(projectName, sessionId, provider),
  );

  const refreshPendingStatus = useCallback(() => {
    setPendingStatus(getPendingStatus(projectName, sessionId, provider));
  }, [projectName, provider, sessionId]);

  const checkPendingDelivery = useCallback(async () => {
    if (provider !== 'codex') {
      return;
    }

    const pendingMessage = loadPendingUserMessage(projectName, sessionId, provider);
    if (!pendingMessage || pendingMessage.status === 'sent') {
      return;
    }

    try {
      const response = await (api.codexPendingDelivery as any)(
        sessionId,
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
        markPendingUserMessageSent(projectName, sessionId, provider);
      } else if (data?.pendingDelivery?.status === 'failed') {
        markPendingUserMessageFailed(projectName, sessionId, provider);
      }
    } catch (error) {
      console.error('Error checking sidebar Codex pending delivery:', error);
    }
  }, [projectName, provider, sessionId]);

  useEffect(() => {
    refreshPendingStatus();

    const handlePendingChange = (event: Event) => {
      const detail = (event as CustomEvent<PendingUserMessageChangedEventDetail>).detail;
      if (
        detail?.projectName === projectName &&
        detail.sessionId === sessionId &&
        detail.provider === provider
      ) {
        setPendingStatus(detail.status);
      }
    };

    const handleStorageChange = () => {
      refreshPendingStatus();
    };

    window.addEventListener(PENDING_USER_MESSAGE_CHANGED_EVENT, handlePendingChange);
    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener(PENDING_USER_MESSAGE_CHANGED_EVENT, handlePendingChange);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [projectName, provider, refreshPendingStatus, sessionId]);

  useEffect(() => {
    if (pendingStatus !== 'sending') {
      return;
    }

    void checkPendingDelivery();
    const intervalId = window.setInterval(() => {
      void checkPendingDelivery();
    }, PENDING_DELIVERY_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [checkPendingDelivery, pendingStatus]);

  useEffect(() => {
    if (pendingStatus !== 'failed') {
      return;
    }

    void checkPendingDelivery();
  }, [checkPendingDelivery, pendingStatus]);

  const status = getSidebarStatus(pendingStatus, isProcessing, showCompleted);
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
