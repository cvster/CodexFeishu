import { useCallback, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { Badge } from '../../../../shared/view/ui';
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
    if (!pendingMessage || pendingMessage.status !== 'sending') {
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

  const badgeClassName =
    status === 'sending'
      ? 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : status === 'failed'
        ? 'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300'
        : status === 'replying'
          ? 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300'
          : 'border-green-500/20 bg-green-500/10 text-green-700 dark:text-green-300';

  const dotClassName =
    status === 'sending'
      ? 'bg-amber-500 animate-pulse'
      : status === 'failed'
        ? 'bg-red-500'
        : status === 'replying'
          ? 'bg-sky-500 animate-pulse'
          : 'bg-green-500';

  return (
    <Badge
      variant="secondary"
      className={cn('inline-flex items-center gap-1 px-1 py-0 text-[10px]', badgeClassName, className)}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dotClassName)} />
      {label}
    </Badge>
  );
}
