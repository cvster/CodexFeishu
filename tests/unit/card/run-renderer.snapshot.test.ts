import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import {
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { normalizeCard } from '../../helpers/card-normalize.js';

describe('run card renderer snapshots', () => {
  it('renders initial running state', () => {
    expectCard(initialState).toMatchSnapshot();
  });

  it('renders active and completed thinking', () => {
    expectCard(stateFrom([{ type: 'thinking', delta: 'checking options' }])).toMatchSnapshot();
    expectCard(stateFrom([
      { type: 'thinking', delta: 'checking options' },
      { type: 'text', delta: 'final answer' },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders tool running, done, and error states', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/missing.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'ENOENT', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('collapses consecutive tools while preserving the latest running tool', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-3', output: 'ok', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders done, error, interrupted, and idle-timeout terminal states', () => {
    expectCard(stateFrom([{ type: 'done', terminationReason: 'normal' }])).toMatchSnapshot();
    expectCard(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }])).toMatchSnapshot();
    expectCard(markInterrupted(stateFrom([{ type: 'text', delta: 'partial' }]))).toMatchSnapshot();
    expectCard(markIdleTimeout(stateFrom([{ type: 'text', delta: 'partial' }]), 15)).toMatchSnapshot();
  });

  it('renders markdown text mode without card-only controls', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'hidden reasoning' },
      { type: 'text', delta: 'Answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'text', delta: 'Done' },
    ]);

    expect(renderText(state)).toMatchSnapshot();
    expect(renderText(markInterrupted(state))).toMatchSnapshot();
    expect(renderText(markIdleTimeout(state, 10))).toMatchSnapshot();
    expect(renderText(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }]))).toMatchSnapshot();
  });

  it('injects signed bridge callback values for managed run controls', () => {
    const card = renderCard(initialState, {
      signCallback: (action) => `token-for-${action}`,
    }) as {
      body?: { elements?: CardElement[] };
    };
    const button = card.body?.elements?.flatMap(buttonsIn).find(
      (element) => element.behaviors?.[0]?.value?.cmd === 'stop',
    );

    expect(button?.behaviors?.[0]?.value).toEqual({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: 'token-for-stop',
    });
  });

  it('renders run controls in one horizontal row', () => {
    for (const [state, labels] of [
      [initialState, ['stop_outlined', 'setting_outlined', 'refresh_outlined', 'mindmap-down_outlined', 'archive_outlined']],
      [stateFrom([{ type: 'done', terminationReason: 'normal' }]), ['stop_outlined', 'setting_outlined', 'refresh_outlined', 'mindmap-down_outlined', 'archive_outlined']],
    ] as const) {
      const card = renderCard(state) as {
        body?: { elements?: CardElement[] };
      };
      const rows = card.body?.elements?.filter((element) => element.tag === 'column_set') ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        flex_mode: 'none',
        columns: [
          { width: 'weighted', weight: 1, horizontal_align: 'center', elements: [{ width: '32px', height: '32px' }] },
          { width: 'weighted', weight: 1, horizontal_align: 'center', elements: [{ width: '32px', height: '32px' }] },
          { width: 'weighted', weight: 1, horizontal_align: 'center', elements: [{ width: '32px', height: '32px' }] },
          { width: 'weighted', weight: 1, horizontal_align: 'center', elements: [{ width: '32px', height: '32px' }] },
          { width: 'weighted', weight: 1, horizontal_align: 'center', elements: [{ width: '32px', height: '32px' }] },
        ],
      });
      const buttons = rows.flatMap(buttonsIn);
      expect(buttons.map((button) => button.icon?.token ?? button.text?.content)).toEqual(labels);
      expect(buttons.map((button) => button.behaviors?.[0]?.value?.cmd))
        .toEqual(['stop', 'config', 'refresh', 'fork', 'finish']);
      for (const button of [buttons[0], buttons[4]]) {
        expect(button).toMatchObject({
          icon: { tag: 'standard_icon', color: 'red' }, border_color: 'red',
          hover_tips: { tag: 'plain_text', content: expect.any(String) },
        });
        expect(button?.text).toBeUndefined();
      }
      for (const button of buttons.slice(1, 4)) {
        expect(button).toMatchObject({
          icon: { tag: 'standard_icon' },
          hover_tips: { tag: 'plain_text', content: expect.any(String) },
        });
        expect(button?.text).toBeUndefined();
      }
      expect(buttons[2]).toMatchObject({ icon: { color: 'green' } });
      expect(buttons[3]).toMatchObject({ icon: { color: 'blue' } });
      for (const button of buttons) {
        expect(button).toMatchObject({
          tag: 'interactive_container', has_border: true, width: '32px', height: '32px',
          border_color: expect.any(String), padding: '0px', vertical_align: 'center',
          elements: [{
            tag: 'column_set', flex_mode: 'none', horizontal_align: 'center', horizontal_spacing: '0px',
            columns: [{ width: '16px', padding: '0px', elements: [{ text_size: 'notation', text_align: 'left' }] }],
          }],
        });
        expect(button.border_color).toEqual(button.icon?.color);
      }
    }
  });

  it('can hide stop while retaining all other icon controls', () => {
    const card = renderCard(initialState, { showStopButton: false }) as {
      body?: { elements?: CardElement[] };
    };
    expect(card.body?.elements?.flatMap(buttonsIn).map((button) => button.icon?.token ?? button.text?.content))
      .toEqual(['setting_outlined', 'refresh_outlined', 'mindmap-down_outlined', 'archive_outlined']);
  });

  it('uses the app-scoped custom Git fork image without changing callbacks', () => {
    const card = renderCard(initialState, { forkIconKey: 'img_test_fork' }) as {
      body?: { elements?: CardElement[] };
    };
    const fork = card.body?.elements?.flatMap(buttonsIn)
      .find((button) => button.behaviors?.[0]?.value?.cmd === 'fork');
    expect(fork).toMatchObject({
      icon: { tag: 'custom_icon', img_key: 'img_test_fork' },
      width: '32px', height: '32px', border_color: 'blue',
      behaviors: [{ value: { cmd: 'fork' } }],
    });
  });

  it('uses a single framed image per production control without prefix icon alignment', () => {
    const actions = ['stop', 'config', 'refresh', 'fork', 'finish'] as const;
    const buttonImageKeys = Object.fromEntries(actions.map((action) => [action, `img_${action}`]));
    const card = renderCard(initialState, { buttonImageKeys, signCallback: () => 'signed-stop' }) as { body: { elements: CardElement[] } };
    const controls = card.body.elements.flatMap(buttonsIn);
    expect(controls).toHaveLength(5);
    controls.forEach((control, index) => {
      expect(control).toMatchObject({
        width: '32px', height: '32px', has_border: false, padding: '0px',
        elements: [{ tag: 'img', img_key: `img_${actions[index]}`, size: '32px 32px',
          scale_type: 'crop_center', margin: '0px', transparent: true, preview: false }],
        behaviors: [{ value: { cmd: actions[index] } }],
      });
      expect(control.icon).toBeUndefined();
    });
    expect(controls[0]?.behaviors?.[0]?.value?.bridge_token).toBe('signed-stop');
    expect(JSON.stringify(controls)).not.toContain('markdown');
  });

  it('keeps local paths in user-visible cards and text fallbacks', () => {
    const sensitivePath = '/Users/example/private/customer/repo/secret.txt';
    const state = stateFrom([
      { type: 'text', delta: `I read ${sensitivePath}` },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: sensitivePath } },
      { type: 'tool_result', id: 'tool-1', output: `content from ${sensitivePath}`, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const card = JSON.stringify(renderCard(state));
    const text = renderText(state);
    expect(card).toContain(sensitivePath);
    expect(text).toContain(sensitivePath);
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

function expectCard(state: RunState) {
  return expect(normalizeCard(renderCard(state)));
}

interface CardElement {
  tag?: string;
  icon?: { token?: string; color?: string };
  border_color?: string;
  elements?: CardElement[];
  text?: { content?: string };
  behaviors?: Array<{ value?: Record<string, unknown> }>;
  columns?: Array<{ elements?: CardElement[] }>;
}

function buttonsIn(element: CardElement): CardElement[] {
  if (element.tag === 'button') return [element];
  if (element.tag === 'interactive_container') return [{ ...element, icon: element.elements?.[0]?.columns?.[0]?.elements?.[0]?.icon }];
  return element.columns?.flatMap((column) => column.elements?.flatMap(buttonsIn) ?? []) ?? [];
}
