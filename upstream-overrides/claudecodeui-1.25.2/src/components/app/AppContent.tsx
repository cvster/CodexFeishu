import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { IS_CODEX_ONLY_HARDENED } from '../../constants/config';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import type { Project, ProjectSession, SessionProvider } from '../../types/app';
import MobileNav from './MobileNav';

const SIDEBAR_STATUS_POLL_INTERVAL_MS = 3000;
const MAX_SIDEBAR_STATUS_POLL_TARGETS = 40;

type SidebarStatusPollTarget = {
  sessionId: string;
  provider: SessionProvider;
};

const SIDEBAR_PROCESSING_STARTED_TYPES = new Set(['codex-desktop-command-submitted']);

const SIDEBAR_PROCESSING_FINISHED_TYPES = new Set([
  'claude-complete',
  'codex-complete',
  'cursor-result',
  'session-aborted',
  'claude-error',
  'cursor-error',
  'codex-error',
  'gemini-error',
  'error',
]);

const addSidebarStatusTargets = (
  targets: SidebarStatusPollTarget[],
  seen: Set<string>,
  sessions: ProjectSession[] | undefined,
  fallbackProvider: SessionProvider,
) => {
  for (const session of sessions ?? []) {
    if (!session.id) {
      continue;
    }

    const provider = (session.__provider || fallbackProvider) as SessionProvider;
    const key = `${provider}:${session.id}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    targets.push({ sessionId: session.id, provider });
  }
};

const collectSidebarStatusPollTargets = (projects: Project[]): SidebarStatusPollTarget[] => {
  const targets: SidebarStatusPollTarget[] = [];
  const seen = new Set<string>();

  for (const project of projects) {
    addSidebarStatusTargets(targets, seen, project.codexSessions, 'codex');

    if (!IS_CODEX_ONLY_HARDENED) {
      addSidebarStatusTargets(targets, seen, project.sessions, 'claude');
      addSidebarStatusTargets(targets, seen, project.cursorSessions, 'cursor');
      addSidebarStatusTargets(targets, seen, project.geminiSessions, 'gemini');
    }

    if (targets.length >= MAX_SIDEBAR_STATUS_POLL_TARGETS) {
      return targets.slice(0, MAX_SIDEBAR_STATUS_POLL_TARGETS);
    }
  }

  return targets;
};

export default function AppContent() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, latestMessage, isConnected } = useWebSocket();
  const wasConnectedRef = useRef(false);
  const [mobileViewportTop, setMobileViewportTop] = useState(0);

  const {
    activeSessions,
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
    replaceTemporarySession,
  } = useSessionProtection();

  const {
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    isInputFocused,
    externalMessageUpdate,
    projects,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    refreshProjectsSilently,
    sidebarSharedProps,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    isMobile,
    activeSessions,
  });
  const sidebarStatusPollTargets = useMemo(
    () => collectSidebarStatusPollTargets(projects),
    [projects],
  );

  useEffect(() => {
    // Expose a non-blocking refresh for chat/session flows.
    // Full loading refreshes are still available through direct fetchProjects calls.
    window.refreshProjects = refreshProjectsSilently;

    return () => {
      if (window.refreshProjects === refreshProjectsSilently) {
        delete window.refreshProjects;
      }
    };
  }, [refreshProjectsSilently]);

  useEffect(() => {
    window.openSettings = openSettings;

    return () => {
      if (window.openSettings === openSettings) {
        delete window.openSettings;
      }
    };
  }, [openSettings]);

  useEffect(() => {
    if (!isMobile || !isInputFocused || typeof window === 'undefined') {
      setMobileViewportTop(0);
      return;
    }

    const updateViewportTop = () => {
      setMobileViewportTop(window.visualViewport?.offsetTop ?? 0);
    };

    updateViewportTop();

    const visualViewport = window.visualViewport;
    window.addEventListener('resize', updateViewportTop);
    visualViewport?.addEventListener('resize', updateViewportTop);
    visualViewport?.addEventListener('scroll', updateViewportTop);

    return () => {
      window.removeEventListener('resize', updateViewportTop);
      visualViewport?.removeEventListener('resize', updateViewportTop);
      visualViewport?.removeEventListener('scroll', updateViewportTop);
    };
  }, [isInputFocused, isMobile]);

  const openSidebar = useCallback(() => {
    if (typeof document !== 'undefined') {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
    }

    setIsInputFocused(false);
    setSidebarOpen(true);
  }, [setIsInputFocused, setSidebarOpen]);

  // Permission recovery: query pending permissions on WebSocket reconnect or session change
  useEffect(() => {
    const isReconnect = isConnected && !wasConnectedRef.current;

    if (isReconnect) {
      wasConnectedRef.current = true;
    } else if (!isConnected) {
      wasConnectedRef.current = false;
    }

    if (isConnected && selectedSession?.id) {
      sendMessage({
        type: 'get-pending-permissions',
        sessionId: selectedSession.id
      });
    }
  }, [isConnected, selectedSession?.id, sendMessage]);

  useEffect(() => {
    if (!isConnected || sidebarStatusPollTargets.length === 0) {
      return;
    }

    const pollSidebarSessionStatuses = () => {
      sidebarStatusPollTargets.forEach((target) => {
        sendMessage({
          type: 'check-session-status',
          sessionId: target.sessionId,
          provider: target.provider,
        });
      });
    };

    pollSidebarSessionStatuses();
    const intervalId = window.setInterval(pollSidebarSessionStatuses, SIDEBAR_STATUS_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isConnected, sendMessage, sidebarStatusPollTargets]);

  useEffect(() => {
    const messageType = latestMessage?.type;
    const messageSessionId =
      typeof latestMessage?.sessionId === 'string' ? latestMessage.sessionId : null;

    if (!messageType || !messageSessionId) {
      return;
    }

    if (messageType === 'session-status') {
      if (latestMessage.isProcessing) {
        markSessionAsProcessing(messageSessionId);
      } else {
        markSessionAsInactive(messageSessionId);
        markSessionAsNotProcessing(messageSessionId);
      }
      return;
    }

    if (SIDEBAR_PROCESSING_STARTED_TYPES.has(messageType)) {
      markSessionAsProcessing(messageSessionId);
      return;
    }

    if (SIDEBAR_PROCESSING_FINISHED_TYPES.has(messageType)) {
      markSessionAsInactive(messageSessionId);
      markSessionAsNotProcessing(messageSessionId);
    }
  }, [
    latestMessage,
    markSessionAsInactive,
    markSessionAsNotProcessing,
    markSessionAsProcessing,
  ]);

  return (
    <div className="fixed inset-0 flex bg-background">
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Sidebar {...sidebarSharedProps} processingSessions={processingSessions} />
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar {...sidebarSharedProps} processingSessions={processingSessions} />
          </div>
        </div>
      )}

      <div className={`flex min-w-0 flex-1 flex-col ${isMobile && !IS_CODEX_ONLY_HARDENED ? 'pb-mobile-nav' : ''}`}>
        <MainContent
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={sendMessage}
          latestMessage={latestMessage}
          isMobile={isMobile}
          onMenuClick={openSidebar}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionActive={markSessionAsActive}
          onSessionInactive={markSessionAsInactive}
          onSessionProcessing={markSessionAsProcessing}
          onSessionNotProcessing={markSessionAsNotProcessing}
          processingSessions={processingSessions}
          onReplaceTemporarySession={replaceTemporarySession}
          onNavigateToSession={(targetSessionId: string) => navigate(`/session/${targetSessionId}`)}
          onShowSettings={() => setShowSettings(true)}
          externalMessageUpdate={externalMessageUpdate}
          isInputFocused={isInputFocused}
          mobileViewportTop={mobileViewportTop}
        />
      </div>

      {isMobile && !IS_CODEX_ONLY_HARDENED && (
        <MobileNav
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          isInputFocused={isInputFocused}
        />
      )}

    </div>
  );
}
