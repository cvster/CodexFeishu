/** Keep app-server naming when supplied; only fill its legacy missing suffix. */
export function nextCodexForkName(sourceName: string, existingNames: readonly string[]): string {
  const base = sourceName.trim().replace(/\s+\(\d+\)$/, '') || 'Codex会话';
  const used = new Set(existingNames.map((name) => name.trim()));
  let suffix = 1;
  while (used.has(`${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
}
