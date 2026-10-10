import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import { CodexThreadReader } from '../../packages/codex-core/src/thread-client';

describe('public shared queue RPC', () => {
  it('lists pages and sends raw input with a stable client ID over the shared server', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const requests: any[] = [];
    server.on('connection', socket => socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString()); requests.push(message);
      if (message.id === undefined) return;
      const result = message.method === 'thread/queue/list'
        ? { data: [{ id: message.params.cursor ? 'q2' : 'q1', clientUserMessageId: 'u1', input: [] }],
          nextCursor: message.params.cursor ? null : 'page2' }
        : message.method === 'thread/queue/add'
          ? { queuedSubmission: { id: 'q3', clientUserMessageId: message.params.clientUserMessageId, input: message.params.input } }
          : {};
      socket.send(JSON.stringify({ id: message.id, result }));
    }));
    const reader = new CodexThreadReader({ binary: 'unused', profileStateDir: '.', sharedServer: true,
      passive: true, remote: `ws://127.0.0.1:${address.port}` });
    try {
      expect((await reader.listQueuedSubmissions('t1')).map(q => q.id)).toEqual(['q1', 'q2']);
      expect(await reader.addQueuedSubmission({ submissionId: 's', clientUserMessageId: 'u3', threadId: 't1',
        prompt: '原样\n', images: ['C:/image.png'] })).toMatchObject({ id: 'q3', clientUserMessageId: 'u3' });
      expect(requests.find(r => r.method === 'thread/queue/add').params).toEqual({ threadId: 't1', clientUserMessageId: 'u3',
        input: [{ type: 'text', text: '原样\n', text_elements: [] }, { type: 'localImage', path: 'C:/image.png' }] });
      expect(requests.some(r => r.method === 'thread/resume' || r.method === 'thread/queue/start')).toBe(false);
    } finally { await reader.stop(); server.close(); }
  });
});
