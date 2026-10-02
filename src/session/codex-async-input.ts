import type { CodexThreadItem, CodexThreadTurn } from './codex-thread-reader';
import type { CodexInputAnswers, CodexInputRequest } from './codex-user-input';

const OPEN = '<send_user_message_question_reply>';
const CLOSE = '</send_user_message_question_reply>';

/** The only Desktop answer-format compatibility seam. Transport is public turn/steer. */
export function parseCodexAsyncInput(threadId: string, turnId: string, item: CodexThreadItem): CodexInputRequest | undefined {
  if (item.type !== 'agentMessage' || typeof item.id !== 'string' ||
    !item.id || !Array.isArray(item.questions) || !item.questions.length) return;
  const questions: CodexInputRequest['questions'] = [];
  for (const [index, raw] of item.questions.entries()) {
    const q = record(raw);
    if (typeof q?.title !== 'string' || !q.title.trim()) return;
    if (q.options != null && (!Array.isArray(q.options) || !q.options.length ||
      q.options.some((option) => typeof option !== 'string' || !option.trim()))) return;
    questions.push({ id: JSON.stringify(['request_user_input_async', item.id, index]),
      header: `问题 ${index + 1}`, question: q.title, isOther: true, isSecret: false,
      options: Array.isArray(q.options) ? q.options.map((label: string) => ({ label, description: '' })) : null });
  }
  return { kind: 'async', threadId, turnId, itemId: item.id, questions, isBlocking: false };
}

export function serializeCodexAsyncAnswers(request: CodexInputRequest, answers: CodexInputAnswers): string {
  if (request.kind !== 'async') throw new Error('Not an asynchronous question');
  const replies = request.questions.flatMap((q) => {
    const values = answers[q.id]?.answers;
    if (values === undefined) return []; // Desktop permits partial groups.
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string' || !values[0].trim()) {
      throw new Error('Missing asynchronous answer');
    }
    return [{ questionItemId: q.id, question: q.question, answer: values[0] }];
  });
  if (!replies.length) throw new Error('Missing asynchronous answer');
  return `${OPEN}\n${JSON.stringify(replies)}\n${CLOSE}`;
}

/** Only real user/accepted steering items count; quoted assistant text never closes a form. */
export function codexAsyncAnsweredIds(turn: CodexThreadTurn): Set<string> {
  const ids = new Set<string>();
  for (const item of turn.items) {
    if (item.type !== 'userMessage' && item.type !== 'steeringUserMessage') continue;
    if (item.type === 'steeringUserMessage' && item.status !== 'accepted') continue;
    const input = item.type === 'steeringUserMessage' ? item.input : item.content;
    if (!Array.isArray(input) || input.length !== 1) continue;
    const content = record(input[0]);
    if (content?.type !== 'text' || typeof content.text !== 'string') continue;
    const text = content.text.trim();
    if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(OPEN.length, -CLOSE.length).trim());
      const replies = Array.isArray(parsed) ? parsed : [parsed];
      if (!replies.length || replies.some((raw) => {
        const reply = record(raw);
        return typeof reply?.questionItemId !== 'string' || typeof reply.question !== 'string' || typeof reply.answer !== 'string';
      })) continue;
      for (const raw of replies) ids.add((raw as { questionItemId: string }).questionItemId);
    } catch { /* Ordinary user text is not an answer envelope. */ }
  }
  return ids;
}

export class CodexAsyncAnswerUnconfirmedError extends Error {
  constructor() { super('回答发送状态尚未确认，请在 Codex 桌面查看，暂勿重复提交'); }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
