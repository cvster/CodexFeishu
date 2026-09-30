import type { CodexThreadItem, CodexThreadTurn } from '../session/codex-thread-reader';
import type { Block, RunState, Terminal, ToolEntry } from './run-state';

export function codexTurnRunState(
  turn: CodexThreadTurn,
  runtime: { firstSeenAtMs: number; lastActivityAtMs: number; checkedAtMs: number },
): RunState {
  const blocks: Block[] = [];
  let reasoning = '';
  for (const item of turn.items) {
    if (item.type === 'agentMessage') {
      const text = stringValue(item.text);
      if (text) blocks.push({ kind: 'text', content: text, streaming: !isCodexTurnTerminal(turn.status) });
      continue;
    }
    if (item.type === 'reasoning') {
      reasoning += textFromUnknown(item.summary) || textFromUnknown(item.content);
      continue;
    }
    const tool = toolFromItem(item, isCodexTurnTerminal(turn.status));
    if (tool) blocks.push({ kind: 'tool', tool });
  }

  const terminal = codexTurnTerminal(turn.status);
  return {
    blocks,
    reasoning: { content: reasoning, active: terminal === 'running' && Boolean(reasoning) },
    footer: terminal === 'running'
      ? (blocks.some((block) => block.kind === 'tool' && block.tool.status === 'running')
          ? 'tool_running'
          : blocks.length > 0
            ? 'streaming'
            : 'thinking')
      : null,
    terminal,
    ...(terminal === 'error' && turn.error?.message ? { errorMsg: turn.error.message } : {}),
    runtime: {
      startedAtMs: runtime.firstSeenAtMs,
      lastActivityAtMs: runtime.lastActivityAtMs,
      checkedAtMs: runtime.checkedAtMs,
      processRunning: terminal === 'running',
    },
  };
}

export function codexTurnTerminal(status: string): Terminal {
  const normalized = status.toLowerCase();
  if (normalized === 'completed') return 'done';
  if (normalized === 'failed') return 'error';
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'interrupted') {
    return 'interrupted';
  }
  return 'running';
}

export function isCodexTurnTerminal(status: string): boolean {
  return codexTurnTerminal(status) !== 'running';
}

function toolFromItem(item: CodexThreadItem, terminal: boolean): ToolEntry | undefined {
  const id = stringValue(item.id);
  if (!id) return undefined;
  if (item.type === 'commandExecution') {
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
    return {
      id,
      name: 'command_execution',
      input: { command: stringValue(item.command) ?? '' },
      status: exitCode === undefined && !terminal
        ? 'running'
        : exitCode === 0 || exitCode === undefined
          ? 'done'
          : 'error',
      ...(stringValue(item.aggregatedOutput) ? { output: stringValue(item.aggregatedOutput) } : {}),
    };
  }
  if (item.type === 'mcpToolCall') {
    const status = stringValue(item.status)?.toLowerCase();
    return {
      id,
      name: [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join('/') || 'mcp_tool',
      input: item.arguments ?? {},
      status: status === 'failed' ? 'error' : status === 'inprogress' && !terminal ? 'running' : 'done',
      ...(textFromUnknown(item.result) ? { output: textFromUnknown(item.result) } : {}),
    };
  }
  return undefined;
}

function textFromUnknown(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input
    .map((value) => {
      if (typeof value === 'string') return value;
      if (!value || typeof value !== 'object') return '';
      const record = value as Record<string, unknown>;
      return stringValue(record.text) ?? stringValue(record.content) ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}
