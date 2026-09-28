const RUNTIME_STATUS_RE = /(?:^|\n\n)(<font color='(?:green|red)'>[^\n<]*<\/font>)\s*$/;

export type MarkdownContinuationReason = 'transport' | 'window_rotated' | 'window_timeout';

const CONTINUATION_NOTICE: Record<MarkdownContinuationReason, string> = {
  transport: '> ⚠️ **流式连接已恢复，以下继续输出；前文见上一条消息。**',
  window_rotated:
    "> <font color='green'>接上一张卡片继续；前文见上一条消息。</font>",
  window_timeout:
    "> <font color='green'>接上一张卡片继续；前文见上一条消息。</font>",
};

const WINDOW_CLOSED_NOTICE =
  "<font color='green'>本卡片已自动续传，后续输出见下一条消息。</font>";

/**
 * Render a replacement streaming message after the original CardKit stream
 * becomes unusable. Start at the last line that was not definitely confirmed
 * so uncertain transport failures cannot lose content. Usually this repeats
 * only one partial line; if earlier tool statuses changed, it may repeat from
 * the first changed line, which is safer than omitting output.
 */
export function renderMarkdownContinuation(
  confirmed: string,
  current: string,
  reason: MarkdownContinuationReason = 'transport',
): string {
  const confirmedParts = splitRuntimeStatus(confirmed);
  const currentParts = splitRuntimeStatus(current);
  const commonChars = commonPrefixLength(confirmedParts.body, currentParts.body);
  const lineStart = currentParts.body.startsWith(confirmedParts.body)
    ? confirmedParts.body.length
    : currentParts.body.lastIndexOf('\n', Math.max(0, commonChars - 1)) + 1;
  const continuation = currentParts.body.slice(lineStart).trim();
  const parts = [CONTINUATION_NOTICE[reason]];
  if (continuation) parts.push(continuation);
  if (currentParts.status) parts.push(currentParts.status);
  return parts.join('\n\n');
}

export function renderMarkdownWindowClosed(current: string): string {
  const parts = [current.trimEnd(), WINDOW_CLOSED_NOTICE].filter(Boolean);
  return parts.join('\n\n');
}

function splitRuntimeStatus(markdown: string): { body: string; status?: string } {
  const match = markdown.match(RUNTIME_STATUS_RE);
  if (!match || match.index === undefined) return { body: markdown.trimEnd() };
  return {
    body: markdown.slice(0, match.index).trimEnd(),
    ...(match[1] ? { status: match[1] } : {}),
  };
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
