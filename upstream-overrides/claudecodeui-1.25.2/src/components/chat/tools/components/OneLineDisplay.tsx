import React, { useMemo, useState } from 'react';
import { copyTextToClipboard } from '../../../../utils/clipboard';

type ActionType = 'copy' | 'open-file' | 'jump-to-results' | 'none';

interface OneLineDisplayProps {
  toolName: string;
  icon?: string;
  label?: string;
  value: string;
  secondary?: string;
  action?: ActionType;
  onAction?: () => void;
  style?: string;
  wrapText?: boolean;
  colorScheme?: {
    primary?: string;
    secondary?: string;
    background?: string;
    border?: string;
    icon?: string;
  };
  resultId?: string;
  toolResult?: any;
  toolId?: string;
}

/**
 * Unified one-line display for simple tool inputs and results
 * Used by: Bash, Read, Grep/Glob (minimized), TodoRead, etc.
 */
export const OneLineDisplay: React.FC<OneLineDisplayProps> = ({
  toolName,
  icon,
  label,
  value,
  secondary,
  action = 'none',
  onAction,
  style,
  wrapText = false,
  colorScheme = {
    primary: 'text-gray-700 dark:text-gray-300',
    secondary: 'text-gray-500 dark:text-gray-400',
    background: '',
    border: 'border-gray-300 dark:border-gray-600',
    icon: 'text-gray-500 dark:text-gray-400'
  },
  toolResult,
  toolId
}) => {
  const [copied, setCopied] = useState(false);
  const isTerminal = style === 'terminal';
  const commandPreview = useMemo(() => {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= 72) {
      return normalized;
    }
    return `${normalized.slice(0, 72)}...`;
  }, [value]);

  const handleAction = async () => {
    if (action === 'copy' && value) {
      const didCopy = await copyTextToClipboard(value);
      if (!didCopy) {
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else if (onAction) {
      onAction();
    }
  };

  const renderCopyButton = () => (
    <button
      onClick={handleAction}
      className="ml-1 flex-shrink-0 text-gray-400 opacity-0 transition-all hover:text-gray-600 group-hover:opacity-100 dark:hover:text-gray-200"
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <svg className="h-3 w-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );

  // Terminal style: collapse commands by default so long shell invocations don't dominate the chat.
  if (isTerminal) {
    return (
      <details className="group/details my-1 rounded-md border border-green-500/20 bg-gray-950/40 px-2.5 py-1.5 dark:bg-black/30">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-gray-300">
          <svg
            className="h-3 w-3 flex-shrink-0 text-green-500 transition-transform duration-150 group-open/details:rotate-90 dark:text-green-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <svg className="h-3 w-3 flex-shrink-0 text-green-500 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span className="flex-shrink-0 font-medium text-green-500 dark:text-green-400">{label || toolName}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-400">
            <span className="mr-1 select-none text-green-700 dark:text-green-600">$</span>
            {commandPreview}
          </span>
        </summary>

        <div className="group mt-2 flex items-start gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <div className="min-w-0 flex-1 rounded bg-gray-900 px-2.5 py-1 dark:bg-black">
              <code className={`font-mono text-xs text-green-400 ${wrapText ? 'whitespace-pre-wrap break-all' : 'block truncate'}`}>
                <span className="select-none text-green-600 dark:text-green-500">$ </span>{value}
              </code>
            </div>
            {action === 'copy' && renderCopyButton()}
          </div>
        </div>

        {secondary && (
          <div className="mt-1 pl-5">
            <span className="text-[11px] italic text-gray-400 dark:text-gray-500">
              {secondary}
            </span>
          </div>
        )}
      </details>
    );
  }

  // File open style - show filename only, full path on hover
  if (action === 'open-file') {
    const displayName = value.split('/').pop() || value;
    return (
      <div className={`group flex items-center gap-1.5 border-l-2 ${colorScheme.border} my-0.5 py-0.5 pl-3`}>
        <span className="flex-shrink-0 text-xs text-gray-500 dark:text-gray-400">{label || toolName}</span>
        <span className="text-[10px] text-gray-300 dark:text-gray-600">/</span>
        <button
          onClick={handleAction}
          className="truncate font-mono text-xs text-blue-600 transition-colors hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
          title={value}
        >
          {displayName}
        </button>
      </div>
    );
  }

  // Search / jump-to-results style
  if (action === 'jump-to-results') {
    return (
      <div className={`group flex items-center gap-1.5 border-l-2 ${colorScheme.border} my-0.5 py-0.5 pl-3`}>
        <span className="flex-shrink-0 text-xs text-gray-500 dark:text-gray-400">{label || toolName}</span>
        <span className="text-[10px] text-gray-300 dark:text-gray-600">/</span>
        <span className={`min-w-0 flex-1 truncate font-mono text-xs ${colorScheme.primary}`}>
          {value}
        </span>
        {secondary && (
          <span className="flex-shrink-0 text-[11px] italic text-gray-400 dark:text-gray-500">
            {secondary}
          </span>
        )}
        {toolResult && (
          <a
            href={`#tool-result-${toolId}`}
            className="flex flex-shrink-0 items-center gap-0.5 text-[11px] text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </a>
        )}
      </div>
    );
  }

  // Default one-line style
  return (
    <div className={`group flex items-center gap-1.5 ${colorScheme.background || ''} border-l-2 ${colorScheme.border} my-0.5 py-0.5 pl-3`}>
      {icon && icon !== 'terminal' && (
        <span className={`${colorScheme.icon} flex-shrink-0 text-xs`}>{icon}</span>
      )}
      {!icon && (label || toolName) && (
        <span className="flex-shrink-0 text-xs text-gray-500 dark:text-gray-400">{label || toolName}</span>
      )}
      {(icon || label || toolName) && (
        <span className="text-[10px] text-gray-300 dark:text-gray-600">/</span>
      )}
      <span className={`font-mono text-xs ${wrapText ? 'whitespace-pre-wrap break-all' : 'truncate'} min-w-0 flex-1 ${colorScheme.primary}`}>
        {value}
      </span>
      {secondary && (
        <span className={`text-[11px] ${colorScheme.secondary} flex-shrink-0 italic`}>
          {secondary}
        </span>
      )}
      {action === 'copy' && renderCopyButton()}
    </div>
  );
};
