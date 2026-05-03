import React from 'react';
import { useTranslation } from 'react-i18next';
import { IS_CODEX_ONLY_HARDENED } from '../../../../constants/config';
import { CODEX_REASONING_EFFORTS } from '../../../../../shared/modelConstants';
import type { PermissionMode, Provider } from '../../types/types';
import ThinkingModeSelector from './ThinkingModeSelector';

interface ChatInputControlsProps {
  permissionMode: PermissionMode | string;
  onModeSwitch: () => void;
  provider: Provider | string;
  codexReasoningEffort: string;
  setCodexReasoningEffort: React.Dispatch<React.SetStateAction<string>>;
  thinkingMode: string;
  setThinkingMode: React.Dispatch<React.SetStateAction<string>>;
  tokenBudget: { used?: number; total?: number } | null;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  isUserScrolledUp: boolean;
  hasMessages: boolean;
  onScrollToBottom: () => void;
}

export default function ChatInputControls({
  provider,
  codexReasoningEffort,
  setCodexReasoningEffort,
  thinkingMode,
  setThinkingMode,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  isUserScrolledUp,
  hasMessages,
  onScrollToBottom,
}: ChatInputControlsProps) {
  const { t } = useTranslation('chat');

  return (
    <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
      {provider === 'claude' && (
        <ThinkingModeSelector selectedMode={thinkingMode} onModeChange={setThinkingMode} onClose={() => {}} className="" />
      )}

      {provider === 'codex' && (
        <label className="flex items-center gap-2 rounded-lg border border-border/50 bg-card px-2 py-1 text-xs text-muted-foreground shadow-sm">
          <span>{t('providerSelection.selectReasoning', { defaultValue: 'Reasoning' })}</span>
          <select
            value={codexReasoningEffort}
            onChange={(event) => {
              const nextValue = event.target.value;
              setCodexReasoningEffort(nextValue);
              localStorage.setItem('codex-reasoning-effort', nextValue);
            }}
            className="max-w-28 cursor-pointer appearance-none bg-transparent text-xs font-medium text-foreground outline-none"
            title={t('providerSelection.selectReasoning', { defaultValue: 'Reasoning' })}
          >
            {CODEX_REASONING_EFFORTS.OPTIONS.map(({ value, label }) => (
              <option key={`${value}-${label}`} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}

      {!IS_CODEX_ONLY_HARDENED && (
        <button
          type="button"
          onClick={onToggleCommandMenu}
          className="relative flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground sm:h-8 sm:w-8"
          title={t('input.showAllCommands')}
        >
          <svg className="h-4 w-4 sm:h-5 sm:w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
            />
          </svg>
          {slashCommandsCount > 0 && (
            <span
              className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground sm:h-5 sm:w-5"
            >
              {slashCommandsCount}
            </span>
          )}
        </button>
      )}

      {hasInput && (
        <button
          type="button"
          onClick={onClearInput}
          className="group flex h-7 w-7 items-center justify-center rounded-lg border border-border/50 bg-card shadow-sm transition-all duration-200 hover:bg-accent/60 sm:h-8 sm:w-8"
          title={t('input.clearInput', { defaultValue: 'Clear input' })}
        >
          <svg
            className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-foreground sm:h-4 sm:w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {isUserScrolledUp && hasMessages && (
        <button
          onClick={onScrollToBottom}
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-all duration-200 hover:scale-105 hover:bg-primary/90 sm:h-8 sm:w-8"
          title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
        >
          <svg className="h-3.5 w-3.5 sm:h-4 sm:w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      )}
    </div>
  );
}
