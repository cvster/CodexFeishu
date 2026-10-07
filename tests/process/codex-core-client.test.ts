import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CodexThreadReader } from '../../packages/codex-core/src/thread-client';

describe('shared app-server RPC client', () => {
  it('handshakes once, fans out notifications, and closes only the owned observer', async () => {
    const requests: Record<string, any>[] = [];
    const children: any[] = [];
    const spawnImpl = vi.fn(() => {
      const child: any = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.exitCode = null; child.signalCode = null;
      child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('close')); return true; };
      child.stdin.on('data', (data: Buffer) => {
        const message = JSON.parse(data.toString()); requests.push(message);
        if (message.id !== undefined) queueMicrotask(() => child.stdout.write(JSON.stringify({
          id: message.id, result: message.method === 'model/list' ? { data: [{ id: 'gpt-6.1-sol' }] } : {},
        }) + '\n'));
      });
      children.push(child); return child;
    });
    const client = new CodexThreadReader({ binary: 'test-cli', profileStateDir: '.', inheritCodexHome: true,
      spawnImpl: spawnImpl as never, passive: true, clientInfo: { name: 'web-app', version: 'test' } });
    try {
      await expect(client.rpc('model/list')).resolves.toEqual({ data: [{ id: 'gpt-6.1-sol' }] });
      await client.rpc('thread/read', { threadId: 'thread' });
      expect(requests.filter((r) => r.method === 'initialize')).toHaveLength(1);
      const notification = client.waitForNotification('turn/completed', (p) => p.threadId === 'thread', 1000);
      children[0].stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread' } }) + '\n');
      await expect(notification).resolves.toEqual({ threadId: 'thread' });
    } finally { await client.stop(); }
    expect(requests.some((r) => r.method === 'turn/interrupt' || r.method === 'thread/queue/delete')).toBe(false);
    expect(spawnImpl).toHaveBeenCalledWith('test-cli', ['app-server', '--listen', 'stdio://'],
      expect.objectContaining({ windowsHide: true }));
  });
});
