export const CODEX_BRIDGE_CLIENT_ID_PREFIX = 'lark-channel-bridge:';

/** Stable per-run marker persisted by Codex on the userMessage item. */
export function codexBridgeClientMessageId(runId: string): string {
  return `${CODEX_BRIDGE_CLIENT_ID_PREFIX}${runId}`;
}

export function isCodexBridgeClientMessageId(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(CODEX_BRIDGE_CLIENT_ID_PREFIX);
}
