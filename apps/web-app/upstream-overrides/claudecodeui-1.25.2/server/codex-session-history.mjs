function extractText(content) {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      if (item.type === 'input_text' || item.type === 'text') return item.text || '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function getCodexResponseUserMessageText(payload) {
  if (payload?.type !== 'message' || payload?.role !== 'user') {
    return null;
  }

  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (!Array.isArray(kinds) || !kinds.includes('user.text')) {
    return null;
  }

  const content = Array.isArray(payload.content)
    ? payload.content.filter((_item, index) => kinds[index] === 'user.text')
    : payload.content;
  const text = extractText(content).trim();
  return text || null;
}

export function selectCodexRolloutCandidate(sessionId, stateRolloutPath, candidates) {
  const validCandidates = (candidates || [])
    .filter((candidate) => candidate?.path?.includes(sessionId) && candidate.path.endsWith('.jsonl'))
    .sort((left, right) => (right.mtimeMs || 0) - (left.mtimeMs || 0));

  if (
    typeof stateRolloutPath === 'string' &&
    stateRolloutPath.includes(sessionId) &&
    stateRolloutPath.endsWith('.jsonl') &&
    validCandidates.some((candidate) => candidate.path === stateRolloutPath)
  ) {
    return stateRolloutPath;
  }

  return validCandidates[0]?.path || null;
}
