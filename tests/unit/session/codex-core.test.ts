import { describe, expect, it, vi } from 'vitest';
import { createPersistedCodexThread } from '../../../packages/codex-core/src/lifecycle';
import { buildNativeQueueArgs } from '../../../packages/codex-core/src/queue';

describe('shared Codex lifecycle', () => {
  it('materializes and validates idle history without starting a model turn', async () => {
    const request = vi.fn(async (method: string) => method === 'thread/start'
      ? { thread: { id: 'idle' } } : method === 'thread/read'
        ? { thread: { id: 'idle', turns: [] } } : {});
    await expect(createPersistedCodexThread({ request }, {
      cwd: '/repo', sandbox: 'workspace-write', model: 'gpt-6.1-sol', reasoningEffort: 'high',
      projectId: 'project', threadSource: 'web-app',
    })).resolves.toBe('idle');
    expect(request.mock.calls.map(([method]) => method)).toEqual(['thread/start', 'thread/name/set', 'thread/read']);
    expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      historyMode: 'legacy', projectId: 'project', model: 'gpt-6.1-sol',
      config: { shell_environment_policy: { inherit: 'all' }, model_reasoning_effort: 'high' },
    }));
  });

  it('rejects unmaterialized history before allowing queue submission', async () => {
    const request = vi.fn(async () => ({ thread: { id: 'idle' } }));
    await expect(createPersistedCodexThread({ request }, { cwd: '/repo', sandbox: 'read-only' }))
      .rejects.toThrow('malformed persisted history');
  });

  it('constructs identical minimal queue commands for both adapters', () => {
    const args = buildNativeQueueArgs({ threadId: 'thread', prompt: 'hi', remote: 'unix://', images: ['/image.png'] });
    expect(args).toEqual(['queue', '--remote', 'unix://', '--thread', 'thread', '--message', 'hi', '--image', '/image.png']);
    expect(args).not.toContain('-c'); expect(args).not.toContain('resume');
  });
});
