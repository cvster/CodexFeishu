import { describe, expect, it } from 'vitest';
import { codexAsyncAnsweredIds, parseCodexAsyncInput, serializeCodexAsyncAnswers } from '../../../src/session/codex-async-input';
import { parseCodexInputRequest } from '../../../src/session/codex-user-input';

const item = { type: 'agentMessage', id: 'call-a', delivery: 'async', text: 'Choose\n- A\n- B',
  questions: [{ title: 'Choose', options: ['A', 'B'] }, { title: 'Anything else?' }] };

describe('Codex asynchronous question compatibility', () => {
  it('reads structured questions, not a Markdown option list, and keeps Desktop question identity', () => {
    const request = parseCodexAsyncInput('thread', 'turn', item)!;
    expect(request.kind).toBe('async');
    expect(request.isBlocking).toBe(false);
    expect(request.questions[0]).toMatchObject({ id: JSON.stringify(['request_user_input_async', 'call-a', 0]),
      question: 'Choose', isOther: true, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] });
    expect(request.questions[1]?.options).toBeNull();
    expect(parseCodexInputRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(parseCodexAsyncInput('thread', 'turn', { ...item, delivery: undefined })).toBeDefined();
    expect(parseCodexAsyncInput('thread', 'turn', { ...item, questions: undefined })).toBeUndefined();
    expect(parseCodexAsyncInput('thread', 'turn', { ...item, questions: [{ title: 'Bad', options: [{}] }] })).toBeUndefined();
  });

  it('uses the same structured user-answer envelope as Desktop, including custom answers', () => {
    const request = parseCodexAsyncInput('thread', 'turn', item)!;
    const answers = Object.fromEntries(request.questions.map((q, index) => [q.id, { answers: [index ? 'custom\ntext' : 'B'] }]));
    const text = serializeCodexAsyncAnswers(request, answers);
    expect(text).toBe('<send_user_message_question_reply>\n' + JSON.stringify([
      { questionItemId: request.questions[0]!.id, question: 'Choose', answer: 'B' },
      { questionItemId: request.questions[1]!.id, question: 'Anything else?', answer: 'custom\ntext' },
    ]) + '\n</send_user_message_question_reply>');
    expect(() => serializeCodexAsyncAnswers(request, {})).toThrow('Missing');
    expect(codexAsyncAnsweredIds({ id: 'turn', status: 'inProgress', items: [
      { type: 'userMessage', content: [{ type: 'text', text }] },
    ] })).toEqual(new Set(request.questions.map((q) => q.id)));
  });

  it('ignores quoted assistant output, malformed envelopes and unaccepted steering', () => {
    const request = parseCodexAsyncInput('thread', 'turn', item)!;
    const text = serializeCodexAsyncAnswers(request, Object.fromEntries(request.questions.map((q) => [q.id, { answers: ['A'] }])));
    const content = [{ type: 'text', text }];
    expect(codexAsyncAnsweredIds({ id: 'turn', status: 'inProgress', items: [
      { type: 'agentMessage', content }, { type: 'steeringUserMessage', status: 'pending', content },
      { type: 'userMessage', content: [{ type: 'text', text: '<send_user_message_question_reply>bad</send_user_message_question_reply>' }] },
    ] }).size).toBe(0);
    expect(codexAsyncAnsweredIds({ id: 'turn', status: 'inProgress', items: [
      { type: 'steeringUserMessage', status: 'accepted', input: content },
    ] }).size).toBe(2);
  });
});
