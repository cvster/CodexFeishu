import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IS_CODEX_ONLY_HARDENED } from '../../../../constants/config';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  SetStateAction,
  TouchEvent,
} from 'react';
import MicButton from '../../../mic-button/view/MicButton';
import type { PendingPermissionRequest, PermissionMode, Provider } from '../../types/types';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  CODEX_REASONING_EFFORTS,
  CURSOR_MODELS,
  GEMINI_MODELS,
} from '../../../../../shared/modelConstants';
import CommandMenu from './CommandMenu';
import ImageAttachment from './ImageAttachment';
import PermissionRequestsBanner from './PermissionRequestsBanner';
import ChatInputControls from './ChatInputControls';

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ChatComposerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  isLoading: boolean;
  isRefreshingLatest: boolean;
  isPendingUserMessageSending: boolean;
  isPendingUserMessageFailed: boolean;
  isPendingUserMessageReplying: boolean;
  provider: Provider | string;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  codexReasoningEffort: string;
  setCodexReasoningEffort: (effort: string) => void;
  geminiModel: string;
  setGeminiModel: (model: string) => void;
  permissionMode: PermissionMode | string;
  onModeSwitch: () => void;
  isSessionProcessing: boolean;
  canAbortSession: boolean;
  onAbortSession: () => void;
  thinkingMode: string;
  setThinkingMode: Dispatch<SetStateAction<string>>;
  tokenBudget: { used?: number; total?: number } | null;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  isUserScrolledUp: boolean;
  hasMessages: boolean;
  onScrollToBottom: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openImagePicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  isInputFocused?: boolean;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
  onTranscript: (text: string) => void;
  onMobileInsetChange?: (height: number) => void;
}

export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  isLoading,
  isRefreshingLatest,
  isPendingUserMessageSending,
  isPendingUserMessageFailed,
  isPendingUserMessageReplying,
  provider,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  codexReasoningEffort,
  setCodexReasoningEffort,
  geminiModel,
  setGeminiModel,
  permissionMode,
  onModeSwitch,
  isSessionProcessing,
  canAbortSession,
  onAbortSession,
  thinkingMode,
  setThinkingMode,
  tokenBudget,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  isUserScrolledUp,
  hasMessages,
  onScrollToBottom,
  onSubmit,
  isDragActive,
  attachedImages,
  onRemoveImage,
  uploadingImages,
  imageErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openImagePicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  isInputFocused,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
  onTranscript,
  onMobileInsetChange,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRect = textareaRef.current?.getBoundingClientRect();
  const commandMenuPosition = {
    top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
    left: textareaRect ? textareaRect.left : 16,
    bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
  };

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );

  // On mobile, when input is focused, float the input box at the bottom
  const mobileFloatingClass = isInputFocused
    ? 'max-sm:sticky max-sm:bottom-0 max-sm:z-30 max-sm:bg-background/95 max-sm:backdrop-blur max-sm:shadow-[0_-4px_20px_rgba(0,0,0,0.15)]'
    : '';
  const inputLeftPaddingClass = IS_CODEX_ONLY_HARDENED ? 'pl-14' : 'pl-24';
  const isSessionBusy = isSessionProcessing || isLoading;
  const isStatusBusy = isRefreshingLatest || isPendingUserMessageSending || isPendingUserMessageReplying || isSessionBusy;
  const modelConfig =
    provider === 'claude'
      ? CLAUDE_MODELS
      : provider === 'cursor'
        ? CURSOR_MODELS
        : provider === 'gemini'
          ? GEMINI_MODELS
          : CODEX_MODELS;
  const currentModel =
    provider === 'claude'
      ? claudeModel
      : provider === 'cursor'
        ? cursorModel
        : provider === 'gemini'
          ? geminiModel
          : codexModel;
  const currentModelLabel =
    modelConfig.OPTIONS.find(({ value }: { value: string; label: string }) => value === currentModel)?.label || currentModel;
  const selectedReasoningEffort =
    CODEX_REASONING_EFFORTS.OPTIONS.some(({ value }) => value === codexReasoningEffort)
      ? codexReasoningEffort
      : CODEX_REASONING_EFFORTS.DEFAULT;
  const reasoningLabel =
    CODEX_REASONING_EFFORTS.OPTIONS.find(({ value }) => value === selectedReasoningEffort)?.label || selectedReasoningEffort;
  const contextUsed = Number(tokenBudget?.used ?? 0);
  const contextTotal = Number(tokenBudget?.total ?? 0);
  const contextPercent =
    Number.isFinite(contextUsed) && Number.isFinite(contextTotal) && contextTotal > 0
      ? Math.min(100, Math.max(0, Math.round((contextUsed / contextTotal) * 100)))
      : null;
  const contextLabel =
    contextPercent === null
      ? '--'
      : t('input.contextUsagePercent', {
          defaultValue: '{{percent}}%',
          percent: contextPercent,
        });
  const sessionStatusLabel = isRefreshingLatest
    ? t('common:buttons.refresh')
    : isPendingUserMessageSending
      ? t('deliveryStatus.sending', { defaultValue: '发送中' })
    : isPendingUserMessageFailed
      ? t('deliveryStatus.failed', { defaultValue: '发送失败' })
    : isPendingUserMessageReplying
      ? t('deliveryStatus.replying', { defaultValue: '回复中' })
    : isSessionBusy
      ? t('thinking.title')
      : t('common:status.completed');

  const handleModelChange = (nextModel: string) => {
    if (provider === 'claude') {
      setClaudeModel(nextModel);
      localStorage.setItem('claude-model', nextModel);
      return;
    }

    if (provider === 'cursor') {
      setCursorModel(nextModel);
      localStorage.setItem('cursor-model', nextModel);
      return;
    }

    if (provider === 'gemini') {
      setGeminiModel(nextModel);
      localStorage.setItem('gemini-model', nextModel);
      return;
    }

    setCodexModel(nextModel);
    localStorage.setItem('codex-model', nextModel);
  };

  const handleReasoningChange = (nextReasoningEffort: string) => {
    setCodexReasoningEffort(nextReasoningEffort);
    localStorage.setItem('codex-reasoning-effort', nextReasoningEffort);
  };

  useEffect(() => {
    if (!onMobileInsetChange || typeof window === 'undefined') {
      return;
    }

    const updateInset = () => {
      const isMobileViewport = window.matchMedia('(max-width: 640px)').matches;
      if (!isMobileViewport || !isInputFocused) {
        onMobileInsetChange(0);
        return;
      }

      const nextHeight = containerRef.current?.offsetHeight ?? 0;
      onMobileInsetChange(nextHeight);
    };

    updateInset();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && containerRef.current
        ? new ResizeObserver(() => updateInset())
        : null;
    if (resizeObserver && containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    const visualViewport = window.visualViewport;
    window.addEventListener('resize', updateInset);
    visualViewport?.addEventListener('resize', updateInset);
    visualViewport?.addEventListener('scroll', updateInset);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateInset);
      visualViewport?.removeEventListener('resize', updateInset);
      visualViewport?.removeEventListener('scroll', updateInset);
      onMobileInsetChange(0);
    };
  }, [isInputFocused, onMobileInsetChange]);

  return (
    <div
      ref={containerRef}
      className={`flex-shrink-0 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-4 sm:pb-4 md:p-4 md:pb-6 ${mobileFloatingClass}`}
    >
      <div className="mx-auto mb-3 max-w-4xl">
        <PermissionRequestsBanner
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
        />

        {!hasQuestionPanel && <ChatInputControls
          permissionMode={permissionMode}
          onModeSwitch={onModeSwitch}
          provider={provider}
          thinkingMode={thinkingMode}
          setThinkingMode={setThinkingMode}
          tokenBudget={tokenBudget}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={onToggleCommandMenu}
          hasInput={hasInput}
          onClearInput={onClearInput}
          isUserScrolledUp={isUserScrolledUp}
          hasMessages={hasMessages}
          onScrollToBottom={onScrollToBottom}
        />}
      </div>

      {!hasQuestionPanel && <form onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void} className="relative mx-auto max-w-4xl">
        {isDragActive && (
          <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
            <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
              <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
              <p className="text-sm font-medium">Drop images here</p>
            </div>
          </div>
        )}

        {attachedImages.length > 0 && (
          <div className="mb-2 rounded-xl bg-muted/40 p-2">
            <div className="flex flex-wrap gap-2">
              {attachedImages.map((file, index) => (
                <ImageAttachment
                  key={index}
                  file={file}
                  onRemove={() => onRemoveImage(index)}
                  uploadProgress={uploadingImages.get(file.name)}
                  error={imageErrors.get(file.name)}
                />
              ))}
            </div>
          </div>
        )}

        {showFileDropdown && filteredFiles.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md">
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        <div
          {...getRootProps()}
          className={`relative overflow-hidden rounded-2xl border border-border/50 bg-card/80 shadow-sm backdrop-blur-sm transition-all duration-200 focus-within:border-primary/30 focus-within:shadow-md focus-within:ring-1 focus-within:ring-primary/15 ${
            isTextareaExpanded ? 'chat-input-expanded' : ''
          }`}
        >
          <input {...getInputProps()} />
          <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
            <div className={`chat-input-placeholder block w-full whitespace-pre-wrap break-words py-1.5 pr-20 text-[17px] leading-7 text-transparent sm:py-4 sm:pr-40 sm:text-lg ${inputLeftPaddingClass}`}>
              {renderInputWithMentions(input)}
            </div>
          </div>

          <div className="relative z-10">
            <div
              className={`absolute left-3 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border transition-colors sm:h-8 sm:w-8 ${
                isPendingUserMessageFailed
                  ? 'border-red-500/40 bg-red-500/10 text-red-500'
                  : isPendingUserMessageReplying
                  ? 'border-sky-500/40 bg-sky-500/10 text-sky-500'
                  : isStatusBusy
                  ? 'border-orange-400/40 bg-orange-500/10 text-orange-500'
                  : 'border-green-500/30 bg-green-500/10 text-green-600'
              }`}
              title={sessionStatusLabel}
              aria-label={sessionStatusLabel}
            >
              {isPendingUserMessageFailed ? (
                <svg className="h-4 w-4 sm:h-[18px] sm:w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M12 8v5" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M12 17h.01" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
              ) : isPendingUserMessageReplying ? (
                <svg className="h-4 w-4 animate-pulse sm:h-[18px] sm:w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M4 12h6" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M14 12h6" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 4v6" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 14v6" />
                </svg>
              ) : isRefreshingLatest ? (
                <svg className="h-4 w-4 animate-spin sm:h-[18px] sm:w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.2}
                    d="M20 12a8 8 0 10-2.34 5.66"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.2}
                    d="M20 7v5h-5"
                  />
                </svg>
              ) : isPendingUserMessageSending ? (
                <svg className="h-4 w-4 sm:h-[18px] sm:w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.2}
                    d="M5 12h11"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.2}
                    d="M13 8l4 4-4 4"
                  />
                </svg>
              ) : isSessionBusy ? (
                <svg className="h-4 w-4 animate-pulse sm:h-[18px] sm:w-[18px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                </svg>
              ) : (
                <svg className="h-4 w-4 sm:h-[18px] sm:w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M7 12.5l3.2 3.2L17 9" />
                </svg>
              )}
            </div>

            <textarea
              ref={textareaRef}
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={placeholder}
              className={`chat-input-placeholder block max-h-[40vh] min-h-[50px] w-full resize-none overflow-y-auto rounded-2xl bg-transparent py-1.5 pr-20 text-[17px] leading-7 text-foreground placeholder-muted-foreground/50 transition-all duration-200 focus:outline-none sm:max-h-[300px] sm:min-h-[80px] sm:py-4 sm:pr-40 sm:text-lg ${inputLeftPaddingClass}`}
              style={{ height: '50px' }}
            />

            {!IS_CODEX_ONLY_HARDENED && (
              <button
                type="button"
                onClick={openImagePicker}
                className="absolute left-12 top-1/2 -translate-y-1/2 transform rounded-xl p-2 transition-colors hover:bg-accent/60"
                title={t('input.attachImages')}
              >
                <svg className="h-5 w-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
              </button>
            )}

            <div className="absolute right-16 top-1/2 -translate-y-1/2 transform sm:right-16" style={{ display: 'none' }}>
              <MicButton onTranscript={onTranscript} className="h-10 w-10 sm:h-10 sm:w-10" />
            </div>

            <button
              type="submit"
              disabled={!input.trim() || (isLoading && !isPendingUserMessageSending)}
              onMouseDown={(event) => {
                event.preventDefault();
                onSubmit(event);
              }}
              onTouchStart={(event) => {
                event.preventDefault();
                onSubmit(event);
              }}
              className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 transform items-center justify-center rounded-xl bg-primary transition-all duration-200 hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:ring-offset-1 focus:ring-offset-background disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground sm:h-11 sm:w-11"
            >
              <svg className="h-4 w-4 rotate-90 transform text-primary-foreground sm:h-[18px] sm:w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>

            <div
              className={`pointer-events-none absolute bottom-1 right-14 hidden text-xs text-muted-foreground/50 transition-opacity duration-200 sm:right-40 sm:block ${IS_CODEX_ONLY_HARDENED ? 'left-14' : 'left-24'} ${
                input.trim() ? 'opacity-0' : 'opacity-100'
              }`}
            >
              {sendByCtrlEnter ? t('input.hintText.ctrlEnter') : t('input.hintText.enter')}
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-nowrap items-center justify-between gap-2 overflow-hidden px-6">
          <div className="flex min-w-0 shrink-0 flex-nowrap items-center gap-2">
            <label
              className="relative flex h-8 w-16 shrink-0 items-center rounded-lg border border-border/50 bg-card/70 px-1 text-xs text-muted-foreground shadow-sm sm:w-20"
              title={t('providerSelection.selectModel', { defaultValue: '选择模型' })}
            >
              <span className="pointer-events-none block min-w-0 flex-1 truncate text-center text-xs font-semibold text-foreground">
                {currentModelLabel}
              </span>
              <select
                value={currentModel}
                onChange={(event) => handleModelChange(event.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label={t('providerSelection.selectModel', { defaultValue: '选择模型' })}
              >
                {modelConfig.OPTIONS.map(({ value, label }: { value: string; label: string }) => (
                  <option key={value + label} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label
              className="relative flex h-8 w-12 shrink-0 items-center rounded-lg border border-border/50 bg-card/70 px-1 text-xs text-muted-foreground shadow-sm sm:w-14"
              title={t('input.reasoningTitle', {
                defaultValue: '选择推理程度：{{reasoning}}',
                reasoning: reasoningLabel,
              })}
            >
              <span className="pointer-events-none block min-w-0 flex-1 truncate text-center text-xs font-semibold text-foreground">
                {reasoningLabel}
              </span>
              <select
                value={selectedReasoningEffort}
                onChange={(event) => handleReasoningChange(event.target.value)}
                disabled={provider !== 'codex'}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                aria-label={t('providerSelection.selectReasoning', { defaultValue: '选择推理程度' })}
              >
                {CODEX_REASONING_EFFORTS.OPTIONS.map(({ value, label }) => (
                  <option key={value + label} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div
              className="flex h-8 w-12 shrink-0 items-center justify-center gap-1 rounded-lg border border-border/50 bg-card/70 px-1 text-xs font-semibold text-muted-foreground shadow-sm sm:w-14"
              title={
                contextPercent === null
                  ? t('input.contextUsageUnknownTitle', { defaultValue: '暂无上下文窗口占用量' })
                  : t('input.contextUsageTitle', {
                      defaultValue: '上下文窗口占用量：{{used}} / {{total}} tokens',
                      used: contextUsed.toLocaleString(),
                      total: contextTotal.toLocaleString(),
                  })
              }
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M4 19V5" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 19v-7" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M14 19V9" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M19 19V3" />
              </svg>
              <span>{contextLabel}</span>
            </div>

            <button
              type="button"
              onClick={onAbortSession}
              disabled={!canAbortSession}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 shadow-sm transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:border-border/50 disabled:bg-card/70 disabled:text-muted-foreground"
              title={t('input.stopThinking', { defaultValue: '停止思考' })}
              aria-label={t('input.stopThinking', { defaultValue: '停止思考' })}
            >
              <span className="h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden="true" />
            </button>
          </div>
        </div>
      </form>}
    </div>
  );
}
