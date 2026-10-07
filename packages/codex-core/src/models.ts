/** UI fallback catalog, not account entitlement. Execution remains server-validated. */
export const CODEX_MODEL_OPTIONS = [
  { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
  { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
  { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
  { value: 'gpt-6-luna', label: 'GPT-6-Luna' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
];

/** Web compatibility choices: retained without adding them to Feishu's picker. */
export const CODEX_LEGACY_MODEL_OPTIONS = [
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
  { value: 'o3', label: 'O3' },
  { value: 'o4-mini', label: 'O4-mini' },
];

export const CODEX_REASONING_OPTIONS = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' },
];

export const CODEX_STANDARD_REASONING_VALUES = CODEX_REASONING_OPTIONS
  .filter((option) => option.value !== 'minimal').map((option) => option.value);
