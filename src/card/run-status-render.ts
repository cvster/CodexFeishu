import type { RunState } from './run-state';

export function renderRunStatus(state: RunState): string | undefined {
  const runtime = state.runtime;
  const context = [
    ...(state.projectName ? [`项目 ${state.projectName}`] : []),
    ...(state.execution
      ? [`${state.execution.model ?? 'CLI 默认（待确认）'} · ${state.execution.reasoningEffort ?? '未知'}`]
      : []),
  ].join(' · ');
  const contextSuffix = context ? ` · ${context}` : '';
  if (!runtime) return context || undefined;

  const elapsed = formatDuration(Math.max(0, runtime.checkedAtMs - runtime.startedAtMs));
  const updatedAt = formatClockTime(runtime.checkedAtMs);
  if (state.terminal !== 'running') {
    return `${terminalLabel(state)} · 用时 ${elapsed} · 最近更新 ${updatedAt}${contextSuffix}`;
  }

  const phase =
    runtime.processRunning === false
      ? '进程已退出，正在收尾'
      : state.footer === 'tool_running'
        ? '正在调用工具'
        : state.footer === 'streaming'
          ? '正在输出'
          : '正在思考';
  const inactiveMs = Math.max(0, runtime.checkedAtMs - runtime.lastActivityAtMs);
  const activity = inactiveMs >= 10_000 ? ` · 最近活动 ${formatDuration(inactiveMs)}前` : '';
  return `运行中 · ${phase} · 已运行 ${elapsed}${activity} · 最近更新 ${updatedAt}${contextSuffix}`;
}

/** Feishu CardKit markdown supports semantic font colors. */
export function renderColoredRunStatus(state: RunState): string | undefined {
  const status = renderRunStatus(state);
  if (!status) return undefined;
  const escaped = status.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<font color='${runStatusColor(state)}'>${escaped}</font>`;
}

export function runStatusColor(state: RunState): 'green' | 'red' {
  if (state.terminal === 'error' || state.terminal === 'idle_timeout') return 'red';
  if (state.terminal === 'interrupted') return 'red';
  if (state.terminal === 'running' && state.runtime?.processRunning === false) return 'red';
  return 'green';
}

function terminalLabel(state: RunState): string {
  if (state.terminal === 'done') return '✅ 已完成';
  if (state.terminal === 'interrupted') return '⏹ 已中断';
  if (state.terminal === 'idle_timeout') return '⏱ 已超时';
  return '⚠️ 运行失败';
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}小时${restMinutes}分` : `${hours}小时`;
}

export function formatClockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
