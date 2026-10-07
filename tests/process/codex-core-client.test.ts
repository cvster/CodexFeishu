import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CodexThreadReader } from '../../packages/codex-core/src/thread-client';

describe('shared app-server RPC client', () => {
  it('holds concurrent requests behind initialization and reconnects without retrying writes', async () => {
    const requests: string[] = [];
    let generation = 0;
    const spawnImpl = vi.fn(() => {
      generation++;
      const child: any = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.exitCode = null; child.signalCode = null;
      child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('close')); return true; };
      let initialized = false;
      child.stdin.on('data', (data: Buffer) => {
        const request = JSON.parse(data.toString()); requests.push(request.method);
        if (request.method === 'initialize') {
          setTimeout(() => { initialized = true; child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'); }, 5);
        } else if (request.id !== undefined) {
          expect(initialized).toBe(true);
          if (request.method === 'thread/name/set' && generation === 1) return;
          queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'));
        }
      });
      return child;
    });
    const client = new CodexThreadReader({ binary: 'test-cli', profileStateDir: '.', inheritCodexHome: true,
      spawnImpl: spawnImpl as never, passive: true, timeoutMs: 50 });
    try {
      await Promise.all([client.rpc('model/list'), client.rpc('thread/read')]);
      expect(requests.slice(0, 4)).toEqual(['initialize', 'initialized', 'model/list', 'thread/read']);
      await expect(client.rpc('thread/name/set')).rejects.toThrow('timed out');
      await client.rpc('thread/read');
      expect(spawnImpl).toHaveBeenCalledTimes(2);
      expect(requests.filter((method) => method === 'thread/name/set')).toHaveLength(1);
    } finally { await client.stop(); }
  });

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
