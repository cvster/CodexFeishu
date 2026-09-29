import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sessionStatePath = new URL(
  '../upstream-overrides/claudecodeui-1.25.2/src/components/chat/hooks/useChatSessionState.ts',
  import.meta.url,
);
const realtimeHandlersPath = new URL(
  '../upstream-overrides/claudecodeui-1.25.2/src/components/chat/hooks/useChatRealtimeHandlers.ts',
  import.meta.url,
);

test('原生 Codex queue 投递后持续同步历史，并在任务结束时最终刷新', async () => {
  const [sessionState, realtimeHandlers] = await Promise.all([
    readFile(sessionStatePath, 'utf8'),
    readFile(realtimeHandlersPath, 'utf8'),
  ]);

  assert.match(sessionState, /CODEX_HISTORY_SYNC_POLL_MS\s*=\s*1500/);
  assert.match(sessionState, /window\.setInterval\(refreshCodexHistory, CODEX_HISTORY_SYNC_POLL_MS\)/);
  assert.match(sessionState, /pendingUserMessage\?\.status === 'sending'/);
  assert.match(sessionState, /isPendingCodexDelivery \|\| isLoading/);
  assert.match(realtimeHandlers, /clearLoadingIndicators\(\);[\s\S]*onCodexCliCommandDelivered\?\.\(\);/);
});
