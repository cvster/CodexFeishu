/** App-server request IDs belong to a connection, not to a conversation. */
export type CodexRequestId = string | number;
export interface CodexInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}
export interface CodexInputRequest {
  kind?: 'async';
  answeredQuestionIds?: string[];
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexInputQuestion[];
  isBlocking: boolean;
}
export type CodexInputAnswers = Record<string, { answers: string[] }>;
export interface CodexInputPrompt {
  requestId: CodexRequestId;
  request: CodexInputRequest;
  /** Native: original RPC; async: steer the exact active turn. False means stale. */
  respond(answers: CodexInputAnswers): Promise<boolean>;
}

export function parseCodexInputRequest(value: unknown): CodexInputRequest | undefined {
  if (!value || typeof value !== 'object') return;
  const p = value as Record<string, unknown>;
  if (typeof p.threadId !== 'string' || typeof p.turnId !== 'string' ||
    typeof p.itemId !== 'string' || !Array.isArray(p.questions) || !p.questions.length) return;
  const questions: CodexInputQuestion[] = [];
  for (const raw of p.questions) {
    if (!raw || typeof raw !== 'object') return;
    const q = raw as Record<string, unknown>;
    if (typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' ||
      questions.some((item) => item.id === q.id)) return;
    if (q.options != null && (!Array.isArray(q.options) || q.options.some((o) =>
      !o || typeof o !== 'object' || typeof o.label !== 'string' || typeof o.description !== 'string'))) return;
    questions.push({ id: q.id, header: typeof q.header === 'string' ? q.header : '',
      question: q.question, isOther: q.isOther === true, isSecret: q.isSecret === true,
      options: Array.isArray(q.options) ? q.options.map((o) => ({ label: o.label, description: o.description })) : null });
  }
  return { threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, questions,
    ...(p.kind === 'async' ? { kind: 'async' as const } : {}),
    ...(p.kind === 'async' && Array.isArray(p.answeredQuestionIds) ? { answeredQuestionIds:
      p.answeredQuestionIds.filter((id): id is string => typeof id === 'string' && questions.some((q) => q.id === id)) } : {}),
    // Older protocol versions didn't send isBlocking (synchronous tool).
    isBlocking: p.isBlocking !== false };
}

export function codexInputKey(request: CodexInputRequest): string {
  return JSON.stringify([request.threadId, request.turnId, request.itemId]);
}
