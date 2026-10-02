import type { CodexInputRequest, CodexInputAnswers } from '../session/codex-user-input';

export type InputCardStatus = 'waiting' | 'submitting' | 'submitted' | 'resolved' | 'disconnected' | 'unconfirmed';

export function codexInputCard(request: CodexInputRequest, token: string, status: InputCardStatus): object {
  const secret = request.questions.some((q) => q.isSecret);
  const enabled = status === 'waiting' && !secret;
  const notice = status === 'submitted' ? request.kind === 'async' ? '✅ 回答已补充给当前任务' : '✅ 回答已发送；若多端同时回答，以 Codex 首次接收的答案为准'
    : status === 'submitting' ? '⏳ 正在提交回答，请勿重复点击'
    : status === 'unconfirmed' ? '回答发送状态尚未确认，请在 Codex 桌面查看，暂勿重复提交。'
    : status === 'resolved' ? '✅ 已在其他端回答，或问题已结束'
    : status === 'disconnected' ? '连接已断开，等待重连；也可以在 Codex 桌面回答。'
    : secret ? '🔒 包含敏感输入，请在 Codex 桌面回答，不要在群内填写。'
    : request.isBlocking ? '⏳ 等待选择 · 提交后继续当前任务'
    : '💬 请选择 · 任务仍在继续，提交后补充给当前任务';
  const elements: object[] = [{ tag: 'markdown', content: notice }];
  const inputs: object[] = [];
  request.questions.forEach((q, index) => {
    inputs.push({ tag: 'markdown', content: `**${escapeMd(q.header || `问题 ${index + 1}`)}**\n\n${escapeMd(q.question)}` });
    if (!enabled) return;
    if (request.kind === 'async' && request.answeredQuestionIds?.includes(q.id)) {
      inputs.push({ tag: 'markdown', content: '✅ 已在其他端回答' });
      return;
    }
    if (q.options?.length) {
      inputs.push({ tag: 'select_static', name: `q_${index}`,
        placeholder: { tag: 'plain_text', content: '请选择' },
        required: !q.isOther,
        options: q.options.map((o, option) => ({
          text: { tag: 'plain_text', content: o.label }, value: String(option),
        })) });
      inputs.push({ tag: 'markdown', content: q.options.map((o) =>
        `• **${escapeMd(o.label)}**${o.description ? `：${escapeMd(o.description)}` : ''}`).join('\n') });
    }
    if (q.isOther || !q.options?.length) {
      inputs.push({ tag: 'input', name: `custom_${index}`,
        label: { tag: 'plain_text', content: q.options?.length ? '自定义回答（填写时优先使用）' : '回答' },
        required: !q.options?.length,
        placeholder: { tag: 'plain_text', content: '输入你的回答' } });
    }
  });
  if (enabled) {
    inputs.push({ tag: 'button', name: 'codex_input_submit', type: 'primary',
      text: { tag: 'plain_text', content: '提交回答' }, form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: { __codex_input: token } }] });
    elements.push({ tag: 'form', name: 'codex_input_form', elements: inputs });
  } else elements.push(...inputs);
  return { schema: '2.0', config: { summary: { content: notice } }, body: { elements } };
}

/** Never trust option labels or question IDs supplied by a card callback. */
export function codexAnswersFromForm(request: CodexInputRequest, form: Record<string, unknown>): CodexInputAnswers {
  if (request.questions.some((q) => q.isSecret)) throw new Error('敏感问题请在 Codex 桌面回答');
  const answers: CodexInputAnswers = Object.create(null) as CodexInputAnswers;
  request.questions.forEach((q, index) => {
    if (request.kind === 'async' && request.answeredQuestionIds?.includes(q.id)) return;
    const custom = typeof form[`custom_${index}`] === 'string' ? (form[`custom_${index}`] as string).trim() : '';
    let answer: string | undefined;
    if (custom && (q.isOther || !q.options?.length)) {
      if (custom.length > 10_000) throw new Error('回答过长，请缩短后重试');
      answer = custom;
    } else if (q.options?.length) {
      const raw = form[`q_${index}`];
      const option = typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : -1;
      answer = q.options[option]?.label;
    }
    if (!answer) throw new Error(`请回答第 ${index + 1} 个问题`);
    answers[q.id] = { answers: [answer] };
  });
  return answers;
}

function escapeMd(value: string): string { return value.replace(/([\\`*_\[\]<>])/g, '\\$1'); }
