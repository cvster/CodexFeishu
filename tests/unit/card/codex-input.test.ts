import { describe, expect, it, vi } from 'vitest';
import { codexAnswersFromForm, codexInputCard } from '../../../src/card/codex-input';
import { parseCodexInputRequest, type CodexInputRequest } from '../../../src/session/codex-user-input';
import { reduce, initialState, startRunRuntime } from '../../../src/card/run-state';
import { renderRunStatus } from '../../../src/card/run-status-render';

const request: CodexInputRequest = { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true,
  questions: [{ id: 'choice', header: '方案', question: '选择哪个方案？', isOther: true, isSecret: false,
    options: [{ label: '方案 A', description: '更简单' }, { label: '方案 B', description: '更灵活' }] },
  { id: 'text', header: '备注', question: '补充要求', isOther: false, isSecret: false, options: null }] };

describe('Codex input cards', () => {
  it('renders one form with options, descriptions and custom answers', () => {
    const json = JSON.stringify(codexInputCard(request, 'token', 'waiting'));
    expect(json).toContain('select_static');
    expect(json).toContain('更简单');
    expect(json).toContain('custom_1');
    expect(json).toContain('等待选择');
    expect(json).toContain('__codex_input');
  });
  it('returns original question IDs and labels, with custom text taking priority', () => {
    expect(codexAnswersFromForm(request, { q_0: '1', custom_1: ' 保留旧数据 ' })).toEqual({
      choice: { answers: ['方案 B'] }, text: { answers: ['保留旧数据'] },
    });
    expect(codexAnswersFromForm(request, { q_0: '0', custom_0: '第三种方案', custom_1: '说明' }).choice)
      .toEqual({ answers: ['第三种方案'] });
  });
  it('rejects missing answers and forged option values', () => {
    for (const raw of ['-1', '4', '01', '方案 A', '', null]) {
      expect(() => codexAnswersFromForm(request, { q_0: raw, custom_1: '备注' })).toThrow('第 1');
    }
    expect(() => codexAnswersFromForm(request, { q_0: '0' })).toThrow('第 2');
  });
  it.each(['submitting', 'submitted', 'resolved', 'disconnected', 'unconfirmed'] as const)('removes callbacks when %s', (status) => {
    const json = JSON.stringify(codexInputCard(request, 'token', status));
    expect(json).not.toContain('__codex_input');
    expect(json).not.toContain('"tag":"form"');
  });
  it('does not collect secret answers in a group', () => {
    const secret = { ...request, questions: request.questions.map((q) => ({ ...q, isSecret: true })) };
    expect(JSON.stringify(codexInputCard(secret, 'token', 'waiting'))).toContain('请在 Codex 桌面回答');
    expect(JSON.stringify(codexInputCard(secret, 'token', 'waiting'))).not.toContain('__codex_input');
    expect(() => codexAnswersFromForm(secret, {})).toThrow('敏感');
  });
  it('shows waiting only for blocking questions', () => {
    const prompt = { requestId: 2, request, respond: vi.fn() };
    const state = startRunRuntime(initialState, 0);
    expect(renderRunStatus(reduce(state, { type: 'user_input', prompt }))).toContain('等待选择');
    expect(renderRunStatus(reduce(state, { type: 'user_input', prompt: { ...prompt, request: { ...request, isBlocking: false } } })))
      .not.toContain('等待选择');
    expect(JSON.stringify(codexInputCard({ ...request, isBlocking: false }, 't', 'waiting'))).toContain('任务仍在继续');
  });
  it('validates protocol data and defaults legacy requests to blocking', () => {
    expect(parseCodexInputRequest({ ...request, isBlocking: undefined })?.isBlocking).toBe(true);
    expect(parseCodexInputRequest({ ...request, questions: [] })).toBeUndefined();
    expect(parseCodexInputRequest({ ...request, questions: [request.questions[0], request.questions[0]] })).toBeUndefined();
    expect(parseCodexInputRequest({ ...request, questions: [{ ...request.questions[0], options: [{}] }] })).toBeUndefined();
  });
});
