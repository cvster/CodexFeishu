import { useState } from 'react';
import { Check, Edit3, Folder, FolderOpen, Plus, Star, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { IS_CODEX_ONLY_HARDENED } from '../../../../constants/config';
import type { Project, ProjectSession, SessionProvider } from '../../../../types/app';
import type { CodexSessionOrigin, MCPServerStatus, SessionWithProvider } from '../../types/types';
import { getTaskIndicatorStatus } from '../../utils/utils';
import TaskIndicator from './TaskIndicator';
import SidebarProjectSessions from './SidebarProjectSessions';
import SidebarProjectStatusBadge from './SidebarProjectStatusBadge';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  processingSessions: Set<string>;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  editingProject: string | null;
  editingName: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingSessions: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onEditingNameChange: (name: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
  onArchiveSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
  onLoadMoreSessions: (project: Project) => void;
  onNewSession: (project: Project, sessionOrigin?: CodexSessionOrigin) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: SessionProvider) => void;
  t: TFunction;
};

const getSessionCountDisplay = (sessions: SessionWithProvider[], hasMoreSessions: boolean): string => {
  const sessionCount = sessions.length;
  if (hasMoreSessions && sessionCount >= 5) {
    return `${sessionCount}+`;
  }

  return `${sessionCount}`;
};

export default function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  processingSessions,
  isExpanded,
  isDeleting,
  isStarred,
  editingProject,
  editingName,
  sessions,
  initialSessionsLoaded,
  isLoadingSessions,
  currentTime,
  editingSession,
  editingSessionName,
  tasksEnabled,
  mcpServerStatus,
  onEditingNameChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onArchiveSession,
  onLoadMoreSessions,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectItemProps) {
  const isSelected = selectedProject?.name === project.name;
  const isEditing = editingProject === project.name;
  const hasMoreSessions = project.sessionMeta?.hasMore === true;
  const sessionCountDisplay = getSessionCountDisplay(sessions, hasMoreSessions);
  const sessionCountLabel = `${sessionCountDisplay} session${sessions.length === 1 ? '' : 's'}`;
  const taskStatus = getTaskIndicatorStatus(project, mcpServerStatus);
  const projectPathLabel = project.isProjectless ? project.displayName : project.fullPath;
  const [isNewSessionDialogOpen, setIsNewSessionDialogOpen] = useState(false);

  const toggleProject = () => onToggleProject(project.name);
  const toggleStarProject = () => onToggleStarProject(project.name);
  const startNewSession = (sessionOrigin?: CodexSessionOrigin) => {
    setIsNewSessionDialogOpen(false);
    onNewSession(project, sessionOrigin);
  };
  const requestNewSession = () => {
    if (IS_CODEX_ONLY_HARDENED) {
      setIsNewSessionDialogOpen(true);
      return;
    }

    startNewSession();
  };
  const renderNewSessionDialog = () => {
    if (!IS_CODEX_ONLY_HARDENED || !isNewSessionDialogOpen) {
      return null;
    }

    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm"
        role="presentation"
        onClick={(event) => {
          event.stopPropagation();
          setIsNewSessionDialogOpen(false);
        }}
      >
        <div
          className="w-full max-w-xs rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-session-dialog-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div id="new-session-dialog-title" className="text-sm font-semibold text-foreground">
            新建会话
          </div>
          <div className="mt-3 grid gap-2">
            <button
              type="button"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => startNewSession('app')}
            >
              App 会话
            </button>
            <button
              type="button"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => startNewSession('backend')}
            >
              后端会话
            </button>
            <button
              type="button"
              className="w-full rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={() => setIsNewSessionDialogOpen(false)}
            >
              取消
            </button>
          </div>
        </div>
      </div>
    );
  };

  const saveProjectName = () => {
    onSaveProjectName(project.name);
  };

  const handleProjectClick = () => toggleProject();

  return (
    <div className={cn('md:space-y-1', isDeleting && 'opacity-50 pointer-events-none')}>
      <div className="md:group group">
        <div className="md:hidden">
          <div
            className={cn(
              'p-3 mx-3 my-1 rounded-lg bg-card border border-border/50 active:scale-[0.98] transition-all duration-150',
              isSelected && 'bg-primary/5 border-primary/20',
              isStarred &&
                !isSelected &&
                'bg-yellow-50/50 dark:bg-yellow-900/5 border-yellow-200/30 dark:border-yellow-800/30',
            )}
            onClick={handleProjectClick}
          >
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div
                  className={cn(
                    'w-8 h-8 rounded-lg flex items-center justify-center transition-colors',
                    isExpanded ? 'bg-primary/10' : 'bg-muted',
                  )}
                >
                  {isExpanded ? (
                    <FolderOpen className="h-4 w-4 text-primary" />
                  ) : (
                    <Folder className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingName}
                      onChange={(event) => onEditingNameChange(event.target.value)}
                      className="w-full rounded-lg border-2 border-primary/40 bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-all duration-200 focus:border-primary focus:shadow-md focus:outline-none"
                      placeholder={t('projects.projectNamePlaceholder')}
                      autoFocus
                      autoComplete="off"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          saveProjectName();
                        }

                        if (event.key === 'Escape') {
                          onCancelEditingProject();
                        }
                      }}
                      style={{
                        fontSize: '16px',
                        WebkitAppearance: 'none',
                        borderRadius: '8px',
                      }}
                    />
                  ) : (
                    <>
                      <div className="flex min-w-0 flex-1 items-center justify-between">
                        <h3 className="truncate text-sm font-medium text-foreground">{project.displayName}</h3>
                        {tasksEnabled && (
                          <TaskIndicator
                            status={taskStatus}
                            size="xs"
                            className="ml-2 hidden flex-shrink-0 md:inline-flex"
                          />
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span>{sessionCountLabel}</span>
                        <SidebarProjectStatusBadge
                          projectName={project.name}
                          sessions={sessions}
                          processingSessions={processingSessions}
                          t={t}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1">
                {isEditing ? (
                  <>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-green-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        saveProjectName();
                      }}
                    >
                      <Check className="h-4 w-4 text-white" />
                    </button>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-gray-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCancelEditingProject();
                      }}
                    >
                      <X className="h-4 w-4 text-white" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={cn(
                        'w-8 h-8 rounded-lg flex items-center justify-center active:scale-90 transition-all duration-150 border',
                        isStarred
                          ? 'bg-yellow-500/10 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800'
                          : 'bg-gray-500/10 dark:bg-gray-900/30 border-gray-200 dark:border-gray-800',
                      )}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleStarProject();
                      }}
                      title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
                    >
                      <Star
                        className={cn(
                          'w-4 h-4 transition-colors',
                          isStarred
                            ? 'text-yellow-600 dark:text-yellow-400 fill-current'
                            : 'text-gray-600 dark:text-gray-400',
                        )}
                      />
                    </button>

                    {!IS_CODEX_ONLY_HARDENED && (
                      <>
                        <button
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 bg-red-500/10 active:scale-90 dark:border-red-800 dark:bg-red-900/30"
                          onClick={(event) => {
                            event.stopPropagation();
                            onDeleteProject(project);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
                        </button>

                        <button
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 active:scale-90 dark:border-primary/30 dark:bg-primary/20"
                          onClick={(event) => {
                            event.stopPropagation();
                            onStartEditingProject(project);
                          }}
                        >
                          <Edit3 className="h-4 w-4 text-primary" />
                        </button>
                      </>
                    )}

                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 active:scale-90 dark:border-primary/30 dark:bg-primary/20"
                      onClick={(event) => {
                        event.stopPropagation();
                        requestNewSession();
                      }}
                      title={t('sessions.newSession')}
                      aria-label={t('sessions.newSession')}
                    >
                      <Plus className="h-4 w-4 text-primary" />
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <Button
          variant="ghost"
          className={cn(
            'hidden md:flex w-full justify-between p-2 h-auto font-normal hover:bg-accent/50',
            isSelected && 'bg-accent text-accent-foreground',
            isStarred &&
              !isSelected &&
              'bg-yellow-50/50 dark:bg-yellow-900/10 hover:bg-yellow-100/50 dark:hover:bg-yellow-900/20',
          )}
          onClick={handleProjectClick}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {isExpanded ? (
              <FolderOpen className="h-4 w-4 flex-shrink-0 text-primary" />
            ) : (
              <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1 text-left">
              {isEditing ? (
                <div className="space-y-1">
                  <input
                    type="text"
                    value={editingName}
                    onChange={(event) => onEditingNameChange(event.target.value)}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:ring-2 focus:ring-primary/20"
                    placeholder={t('projects.projectNamePlaceholder')}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        saveProjectName();
                      }
                      if (event.key === 'Escape') {
                        onCancelEditingProject();
                      }
                    }}
                  />
                  <div className="truncate text-xs text-muted-foreground" title={projectPathLabel}>
                    {projectPathLabel}
                  </div>
                </div>
              ) : (
                <div>
                  <div className="truncate text-sm font-semibold text-foreground" title={project.displayName}>
                    {project.displayName}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{sessionCountDisplay}</span>
                    <SidebarProjectStatusBadge
                      projectName={project.name}
                      sessions={sessions}
                      processingSessions={processingSessions}
                      t={t}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-1">
            {isEditing ? (
              <>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-green-600 transition-colors hover:bg-green-50 hover:text-green-700 dark:hover:bg-green-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveProjectName();
                  }}
                >
                  <Check className="h-3 w-3" />
                </div>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 dark:hover:bg-gray-800"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingProject();
                  }}
                >
                  <X className="h-3 w-3" />
                </div>
              </>
            ) : (
              <>
                <div
                  className={cn(
                    'w-6 h-6 opacity-0 group-hover:opacity-100 transition-all duration-200 flex items-center justify-center rounded cursor-pointer touch:opacity-100',
                    isStarred ? 'hover:bg-yellow-50 dark:hover:bg-yellow-900/20 opacity-100' : 'hover:bg-accent',
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleStarProject();
                  }}
                  title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
                >
                  <Star
                    className={cn(
                      'w-3 h-3 transition-colors',
                      isStarred
                        ? 'text-yellow-600 dark:text-yellow-400 fill-current'
                        : 'text-muted-foreground',
                    )}
                  />
                </div>
                {!IS_CODEX_ONLY_HARDENED && (
                  <>
                    <div
                      className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-0 transition-all duration-200 hover:bg-accent group-hover:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        onStartEditingProject(project);
                      }}
                      title={t('tooltips.renameProject')}
                    >
                      <Edit3 className="h-3 w-3" />
                    </div>
                    <div
                      className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-0 transition-all duration-200 hover:bg-red-50 group-hover:opacity-100 dark:hover:bg-red-900/20"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteProject(project);
                      }}
                      title={t('tooltips.deleteProject')}
                    >
                      <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
                    </div>
                  </>
                )}
                <div
                  className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-100 transition-all duration-200 hover:bg-primary/10 hover:text-primary"
                  onClick={(event) => {
                    event.stopPropagation();
                    requestNewSession();
                  }}
                  title={t('sessions.newSession')}
                  aria-label={t('sessions.newSession')}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      requestNewSession();
                    }
                  }}
                >
                  <Plus className="h-3.5 w-3.5 text-primary" />
                </div>
              </>
            )}
          </div>
        </Button>
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        processingSessions={processingSessions}
        initialSessionsLoaded={initialSessionsLoaded}
        isLoadingSessions={isLoadingSessions}
        currentTime={currentTime}
        editingSession={editingSession}
        editingSessionName={editingSessionName}
        onEditingSessionNameChange={onEditingSessionNameChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onArchiveSession={onArchiveSession}
        onLoadMoreSessions={onLoadMoreSessions}
        onNewSession={onNewSession}
        t={t}
      />
      {renderNewSessionDialog()}
    </div>
  );
}
