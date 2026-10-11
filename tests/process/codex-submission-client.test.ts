import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import { CodexThreadReader } from '../../packages/codex-core/src/thread-client';
import { submitCodexInput } from '../../packages/codex-core/src/submission';

describe('public shared queue RPC', () => {
  it.each(['interrupted', 'completed', 'active', 'failed-start'])('handles a new message after %s without resending input', async previous => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const requests: any[] = []; let added = false;
    server.on('connection', socket => socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString()); requests.push(message);
      if (message.id === undefined) return;
      let result: any = {};
      if (message.method === 'thread/queue/list') result = { data: added ? [{ id: 'next', input: [] }] : [], nextCursor: null };
      if (message.method === 'thread/queue/add') { added = true; result = { queuedSubmission: { id: 'next', input: [] } }; }
      if (message.method === 'thread/read') result = { thread: { id: 't', status: { type: previous === 'active' ? 'active' : 'idle' },
        turns: [{ id: 'old', status: previous === 'completed' ? 'completed' : 'interrupted', items: [] }] } };
      if (message.method === 'thread/queue/start') result = { turn: { id: 'new-turn', status: 'inProgress' } };
      socket.send(JSON.stringify(message.method === 'thread/queue/start' && previous === 'failed-start'
        ? { id: message.id, error: { code: -32600, message: 'write rejected' } } : { id: message.id, result }));
    }));
    const reader = new CodexThreadReader({ binary: 'unused', profileStateDir: '.', sharedServer: true,
      passive: true, remote: `ws://127.0.0.1:${address.port}` });
    try {
      const result = await submitCodexInput({ submissionId: 's', clientUserMessageId: 'u', threadId: 't', prompt: 'next input' },
        { shared: reader, beforeSend: async () => {}, runCli: async () => { throw new Error('Must not fall back'); } });
      expect(result.status).toBe('accepted');
      expect(requests.filter(r => r.method === 'thread/queue/add')).toHaveLength(1);
      expect(requests.filter(r => r.method === 'thread/queue/start').map(r => r.params))
        .toEqual(previous === 'interrupted' || previous === 'failed-start' ? [{ threadId: 't', queuedSubmissionId: 'next' }] : []);
      if (previous === 'failed-start') expect(result).toMatchObject({ continuationWarning: expect.stringContaining('write rejected') });
      expect(requests.some(r => r.method === 'thread/resume' || r.method === 'thread/queue/delete')).toBe(false);
    } finally { await reader.stop(); server.close(); }
  });
  it.each([true, false])('starts exactly the selected queue head and validates its acknowledgement (%s)', async valid => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const requests: any[] = [];
    server.on('connection', socket => socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString()); requests.push(message);
      if (message.id === undefined) return;
      socket.send(JSON.stringify({ id: message.id, result: message.method === 'thread/queue/start'
        ? { turn: valid ? { id: 'next-turn', status: 'inProgress' } : {} } : {} }));
    }));
    const reader = new CodexThreadReader({ binary: 'unused', profileStateDir: '.', sharedServer: true,
      passive: true, remote: `ws://127.0.0.1:${address.port}` });
    try {
      if (valid) expect(await reader.startQueuedTurn('t1', 'q1')).toBe('next-turn');
      else await expect(reader.startQueuedTurn('t1', 'q1')).rejects.toThrow('Invalid queue start response');
      expect(requests.filter(r => r.method === 'thread/queue/start').map(r => r.params))
        .toEqual([{ threadId: 't1', queuedSubmissionId: 'q1' }]);
      expect(requests.some(r => r.method === 'thread/resume' || r.method === 'thread/queue/delete')).toBe(false);
    } finally { await reader.stop(); server.close(); }
  });

  it('does not start queued input through a private embedded server', async () => {
    const reader = new CodexThreadReader({ binary: 'unused', profileStateDir: '.' });
    await expect(reader.startQueuedTurn('t', 'q')).rejects.toThrow('shared writer daemon');
    await reader.stop();
  });
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
