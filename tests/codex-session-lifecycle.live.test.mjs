import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(__dirname, '..');
const upstreamPackage = path.join(workspace, 'vendor', 'claudecodeui-1.25.2', 'package.json');
const require = createRequire(upstreamPackage);
const WebSocket = require('ws');

const token = process.env.TEST_WS_TOKEN;
const projectPath = process.env.TEST_PROJECT_PATH || 'D:\\dorit\\mytest';
const model = process.env.TEST_MODEL || 'gpt-5.6-sol';
const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token || '')}`;
const commandTimeoutMs = Number(process.env.TEST_COMMAND_TIMEOUT_MS || 240_000);
const responseTimeoutMs = Number(process.env.TEST_RESPONSE_TIMEOUT_MS || 240_000);

assert.ok(token, 'TEST_WS_TOKEN is required. Run this test through scripts/run-unit-tests.ps1.');

let backendSessionId = null;
let appSessionId = null;

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function sendCodexCommand(command, options, terminalType) {
  const ws = await connect();
  const events = [];

  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${terminalType}; events=${events.map((event) => event.type).join(',')}`));
      }, commandTimeoutMs);

      const finish = (callback, value) => {
        clearTimeout(timeout);
        callback(value);
      };

      ws.on('message', (raw) => {
        let event;
        try {
          event = JSON.parse(raw.toString());
        } catch (error) {
          finish(reject, error);
          return;
        }

        events.push(event);
        if (event.type === 'codex-error' || event.type === 'codex-desktop-command-error' || event.type === 'error') {
          finish(reject, new Error(event.error || `Codex command failed with ${event.type}`));
          return;
        }

        if (event.type === terminalType) {
          finish(resolve, { terminalEvent: event, events });
        }
      });

      ws.send(JSON.stringify({
        type: 'codex-command',
        command,
        options: {
          cwd: projectPath,
          projectPath,
          model,
          permissionMode: 'default',
          ...options,
        },
      }));
    });
  } finally {
    ws.close();
  }
}

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `${options.method || 'GET'} ${pathname} failed with HTTP ${response.status}`);
  }
  return payload;
}

async function waitForAssistantMarker(sessionId, marker) {
  const deadline = Date.now() + responseTimeoutMs;
  while (Date.now() < deadline) {
    const result = await api(`/api/codex/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
    const found = (result.messages || []).some((message) => (
      message?.message?.role === 'assistant' &&
      typeof message?.message?.content === 'string' &&
      message.message.content.includes(marker)
    ));
    if (found) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Assistant response marker was not found for session ${sessionId}.`);
}

async function archiveSession(sessionId) {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: 'PUT',
    body: JSON.stringify({ provider: 'codex', projectPath }),
  });
}

test('后端会话：真实新建会话并收到助手回复', { timeout: commandTimeoutMs + responseTimeoutMs }, async () => {
  const marker = `LIVE_BACKEND_NEW_${randomUUID()}`;
  const result = await sendCodexCommand(
    `Reply with exactly ${marker}`,
    { executionMode: 'sdk', newSession: true },
    'codex-complete',
  );

  backendSessionId = result.terminalEvent.actualSessionId || result.terminalEvent.sessionId;
  assert.ok(backendSessionId, 'Backend create did not return a session ID.');
  await waitForAssistantMarker(backendSessionId, marker);
});

test('后端会话：向真实已有会话发送消息', { timeout: commandTimeoutMs + responseTimeoutMs }, async () => {
  assert.ok(backendSessionId, 'Backend create test did not produce a session ID.');
  const marker = `LIVE_BACKEND_SEND_${randomUUID()}`;
  await sendCodexCommand(
    `Reply with exactly ${marker}`,
    { executionMode: 'sdk', sessionId: backendSessionId },
    'codex-complete',
  );
  await waitForAssistantMarker(backendSessionId, marker);
});

test('后端会话：真实归档会话', { timeout: commandTimeoutMs }, async () => {
  assert.ok(backendSessionId, 'Backend create test did not produce a session ID.');
  const result = await archiveSession(backendSessionId);
  assert.equal(result.success, true);
});

test('App 会话：真实新建会话并收到助手回复', { timeout: commandTimeoutMs + responseTimeoutMs }, async () => {
  const marker = `LIVE_APP_NEW_${randomUUID()}`;
  const result = await sendCodexCommand(
    `Reply with exactly ${marker}`,
    { executionMode: 'desktop-ui', newSession: true },
    'codex-desktop-command-delivered',
  );

  appSessionId = result.terminalEvent.sessionId;
  assert.ok(appSessionId, 'App create did not return the real Codex session ID.');
  await waitForAssistantMarker(appSessionId, marker);
});

test('App 会话：向真实已有会话发送消息', { timeout: commandTimeoutMs + responseTimeoutMs }, async () => {
  assert.ok(appSessionId, 'App create test did not produce a session ID.');
  const marker = `LIVE_APP_SEND_${randomUUID()}`;
  await sendCodexCommand(
    `Reply with exactly ${marker}`,
    { executionMode: 'desktop-ui', sessionId: appSessionId },
    'codex-desktop-command-delivered',
  );
  await waitForAssistantMarker(appSessionId, marker);
});

test('App 会话：真实归档会话', { timeout: commandTimeoutMs }, async () => {
  assert.ok(appSessionId, 'App create test did not produce a session ID.');
  const result = await archiveSession(appSessionId);
  assert.equal(result.success, true);
});
