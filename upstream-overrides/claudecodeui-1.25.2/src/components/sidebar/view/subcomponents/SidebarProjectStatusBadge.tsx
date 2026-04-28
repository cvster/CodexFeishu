import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { Badge } from '../../../../shared/view/ui';
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

const getBadgeClassName = (status: ProjectSidebarStatus) =>
  status === 'sending'
    ? 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    : status === 'failed'
      ? 'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300'
      : status === 'replying'
        ? 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300'
        : 'border-green-500/20 bg-green-500/10 text-green-700 dark:text-green-300';

const getDotClassName = (status: ProjectSidebarStatus) =>
  status === 'sending'
    ? 'bg-amber-500 animate-pulse'
    : status === 'failed'
      ? 'bg-red-500'
      : status === 'replying'
        ? 'bg-sky-500 animate-pulse'
        : 'bg-green-500';

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
        .filter((pendingMessage) => pendingMessage.status === 'sending' && pendingMessage.provider === 'codex')
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
    <Badge
      variant="secondary"
      className={cn('inline-flex items-center gap-1 px-1 py-0 text-[10px]', getBadgeClassName(status), className)}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', getDotClassName(status))} />
      {label}
    </Badge>
  );
}
