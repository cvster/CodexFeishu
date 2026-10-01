import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import {
  initialState,
  projectNameFromCwd,
  reduce,
  startRunRuntime,
  updateRunRuntime,
} from '../../../src/card/run-state.js';
import {
  formatClockTime,
  renderColoredRunStatus,
  renderRunStatus,
  runStatusColor,
} from '../../../src/card/run-status-render.js';
import { renderText } from '../../../src/card/text-renderer.js';

describe('run status rendering', () => {
  it('derives the project name from Windows and POSIX working directories', () => {
    expect(projectNameFromCwd('C:\\software\\my-project\\')).toBe('my-project');
    expect(projectNameFromCwd('/home/pc/code/my-project/')).toBe('my-project');
    expect(projectNameFromCwd('/')).toBe('/');
    const state = reduce(initialState, {
      type: 'system', cwd: '/home/pc/code/my-project',
      model: 'gpt-6.1-sol', reasoningEffort: 'high',
    });
    expect(renderRunStatus(state)).toBe('项目 my-project · gpt-6.1-sol · high');
    expect(renderText(reduce(state, { type: 'done', terminationReason: 'normal' })))
      .toContain('项目 my-project');
  });

  it('escapes project and execution metadata in colored status markdown', () => {
    const status = renderColoredRunStatus({
      ...initialState, projectName: '<project>&',
      execution: { model: '<model>', reasoningEffort: 'high' },
    });
    expect(status).toContain('&lt;project&gt;&amp;');
    expect(status).toContain('&lt;model&gt;');
    expect(status).not.toContain('<project>');
  });

  it('shows actual per-turn model and effort during streaming and after completion', () => {
    let state = startRunRuntime(initialState, 1_000);
    state = reduce(state, { type: 'system', model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    expect(renderText(state)).toContain('gpt-5.6-sol · high');
    expect(renderText(state)).not.toContain('模型 ');
    expect(renderText(state)).not.toContain(' · 思考 high');
    state = reduce(state, { type: 'system', model: 'gpt-6-sol', reasoningEffort: 'xhigh' });
    state = reduce(state, { type: 'done', terminationReason: 'normal' });
    expect(JSON.stringify(renderCard(state))).toContain('gpt-6-sol · xhigh');
    expect(renderText(state)).toContain('✅ 已完成');
  });
  it('shows phase, elapsed time, and recent activity for a running task', () => {
    let state = startRunRuntime(initialState, 1_000);
    state = reduce(state, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} });
    state = updateRunRuntime(state, { nowMs: 76_000, processRunning: true });

    expect(renderRunStatus(state)).toBe(
      `运行中 · 正在调用工具 · 已运行 1分15秒 · 最近活动 1分15秒前 · 最近更新 ${formatClockTime(76_000)}`,
    );
    expect(JSON.stringify(renderCard(state))).toContain('运行中 · 正在调用工具');
    expect(renderColoredRunStatus(state)).toContain("<font color='green'>");
    expect(renderText(state)).toContain('已运行 1分15秒');
  });

  it('shows process-exit cleanup and terminal duration', () => {
    let state = startRunRuntime(initialState, 1_000);
    state = updateRunRuntime(state, { nowMs: 31_000, processRunning: false });
    expect(renderRunStatus(state)).toContain('进程已退出，正在收尾');
    expect(runStatusColor(state)).toBe('red');

    state = reduce(state, { type: 'done', terminationReason: 'normal' });
    state = updateRunRuntime(state, { nowMs: 66_000, processRunning: false });
    expect(renderRunStatus(state)).toBe(
      `✅ 已完成 · 用时 1分5秒 · 最近更新 ${formatClockTime(66_000)}`,
    );
    expect(runStatusColor(state)).toBe('green');
    expect(JSON.stringify(renderCard(state))).toContain('✅ 已完成 · 用时 1分5秒');
  });

  it('uses red for failed, interrupted, and timed-out terminal states', () => {
    const started = startRunRuntime(initialState, 1_000);
    const error = reduce(started, {
      type: 'error',
      message: 'failed',
      terminationReason: 'failed',
    });
    const interrupted = reduce(started, { type: 'done', terminationReason: 'interrupted' });
    const timedOut = reduce(started, { type: 'done', terminationReason: 'timeout' });

    expect(runStatusColor(error)).toBe('red');
    expect(runStatusColor(interrupted)).toBe('red');
    expect(runStatusColor(timedOut)).toBe('red');
    expect(renderText(error)).toContain("<font color='red'>");
  });
});
