import { describe, expect, it } from 'vitest';
import {
  renderMarkdownContinuation,
  renderMarkdownWindowClosed,
} from '../../../src/card/stream-recovery.js';

describe('markdown stream recovery', () => {
  it('continues after the last confirmed content without repeating the full reply', () => {
    const confirmed = "第一段\n\n第二段\n\n<font color='green'>运行中 · 已运行 15秒</font>";
    const current = "第一段\n\n第二段\n\n第三段\n\n<font color='green'>运行中 · 已运行 30秒</font>";

    const recovered = renderMarkdownContinuation(confirmed, current);

    expect(recovered).not.toContain('第一段');
    expect(recovered).not.toContain('第二段');
    expect(recovered).toContain('第三段');
    expect(recovered).toContain('已运行 30秒');
  });

  it('repeats from the first uncertain line when an earlier tool status changed', () => {
    const confirmed = '> ⏳ **Bash** — run\n\n已有结论';
    const current = '> ✅ **Bash** — run\n\n已有结论\n\n新增结论';

    const recovered = renderMarkdownContinuation(confirmed, current);

    expect(recovered).toContain('> ✅ **Bash** — run');
    expect(recovered).toContain('新增结论');
  });

  it('keeps only the recovery notice and current status when no body changed', () => {
    const confirmed = "答案\n\n<font color='green'>运行中 · 已运行 15秒</font>";
    const current = "答案\n\n<font color='green'>运行中 · 已运行 30秒</font>";

    const recovered = renderMarkdownContinuation(confirmed, current);

    expect(recovered).not.toContain('\n\n答案');
    expect(recovered).toContain('已运行 30秒');
  });

  it('shows a green continuation notice on a replacement card', () => {
    const recovered = renderMarkdownContinuation('已有内容', '已有内容\n\n新增内容', 'window_timeout');

    expect(recovered).toContain("<font color='green'>");
    expect(recovered).toContain('接上一张卡片继续');
    expect(recovered).not.toContain('超时');
    expect(recovered).toContain('新增内容');
  });

  it('marks a proactively closed card before rotating', () => {
    const rendered = renderMarkdownWindowClosed(
      "已有内容\n\n<font color='green'>运行中 · 已运行 8分</font>",
    );

    expect(rendered).toContain('已有内容');
    expect(rendered).toContain("<font color='green'>");
    expect(rendered).toContain('本卡片已自动续传');
    expect(rendered).toContain('后续输出见下一条消息');
  });
});
