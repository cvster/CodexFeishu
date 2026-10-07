import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** No config overrides: those select an embedded server and compete with daemon. */
export function buildNativeQueueArgs(input: { threadId: string; prompt: string; remote?: string;
  images?: readonly string[] }): string[] {
  if (!input.threadId.trim() || !input.prompt.trim()) throw new Error('Queue thread and input are required');
  return ['queue', ...(input.remote ? ['--remote', input.remote] : []),
    '--thread', input.threadId, '--message', input.prompt,
    ...(input.images ?? []).flatMap((image) => ['--image', image])];
}

/** Endpoint presence is a candidate only; joinActiveThread must verify ownership. */
export async function resolveSharedCodexEndpoint(options: { remote?: string; codexHome?: string } = {}): Promise<string | undefined> {
  if (options.remote) return options.remote;
  const socket = join(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    'app-server-control', 'app-server-control.sock');
  return await access(socket).then(() => 'unix://', () => undefined);
}
