import type { SandboxMode } from '../../config/profile-schema';

export interface BuildCodexArgsInput {
  cwd: string;
  sandbox: SandboxMode;
  threadId?: string;
  images?: readonly string[];
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  /** Forwarded to the selected Codex transport. Omitted uses the Codex default. */
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
}

export interface BuildCodexQueueArgsInput {
  cwd: string;
  sandbox: SandboxMode;
  threadId: string;
  prompt: string;
  images?: readonly string[];
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
}

/**
 * Queue follow-up input through Codex's native per-thread queue. Unlike
 * `exec resume`, this does not try to acquire the thread writer lock, so it
 * can target a conversation that is currently owned by Codex Desktop.
 */
export function buildCodexQueueArgs(input: BuildCodexQueueArgsInput): string[] {
  if (
    input.sandbox !== 'read-only' &&
    input.sandbox !== 'workspace-write' &&
    input.sandbox !== 'danger-full-access'
  ) {
    throw new Error(`unsafe sandbox mode: ${input.sandbox}`);
  }

  return [
    'queue',
    '--thread',
    input.threadId,
    '--message',
    input.prompt,
    '--sandbox',
    input.sandbox,
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="all"',
    ...(input.model ? ['--model', input.model] : []),
    ...(input.reasoningEffort
      ? ['-c', `model_reasoning_effort="${input.reasoningEffort}"`]
      : []),
    ...((input.images ?? []).flatMap((path) => ['--image', path])),
    '-C',
    input.cwd,
  ];
}

export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
  if (
    input.sandbox !== 'read-only' &&
    input.sandbox !== 'workspace-write' &&
    input.sandbox !== 'danger-full-access'
  ) {
    throw new Error(`unsafe sandbox mode: ${input.sandbox}`);
  }

  const globalFlags = [
    '--sandbox',
    input.sandbox,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.reasoningEffort
      ? ['-c', `model_reasoning_effort="${input.reasoningEffort}"`]
      : []),
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="all"',
    ...(input.ignoreUserConfig === true ? ['--ignore-user-config'] : []),
    ...(input.ignoreRules === false ? [] : ['--ignore-rules']),
    '--skip-git-repo-check',
    '-C',
    input.cwd,
  ];

  const imageFlags = (input.images ?? []).flatMap((path) => ['--image', path]);

  if (input.threadId) {
    return [
      'exec',
      ...globalFlags,
      'resume',
      '--json',
      ...imageFlags,
      input.threadId,
      '-',
    ];
  }

  return [
    'exec',
    '--json',
    ...globalFlags,
    ...imageFlags,
    ...(imageFlags.length > 0 ? ['--'] : []),
    '-',
  ];
}
