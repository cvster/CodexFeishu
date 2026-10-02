import { CodexThreadReader } from '../../session/codex-thread-reader';
import type { AgentEvent, AgentRun } from '../types';
import { createCodexQueueRun } from './queue';

type FreshQueueOptions = Omit<Parameters<typeof createCodexQueueRun>[0], 'threadId'> & {
  developerInstructions?: string;
};

/** Create idle history, then execute with the external writer, never our child. */
export function createCodexQueuedFreshRun(options: FreshQueueOptions): AgentRun {
  const creator = new CodexThreadReader({
    binary: options.binary, profileStateDir: options.profileStateDir,
    codexHome: options.codexHome, inheritCodexHome: options.inheritCodexHome,
    env: options.env,
  });
  let task: AgentRun | undefined;
  let closed = false;
  let started = false;
  let settled = false;
  let settle!: () => void;
  const completed = new Promise<void>((resolve) => { settle = resolve; });
  const events = (async function* (): AsyncGenerator<AgentEvent> {
    started = true;
    try {
      if (closed) return;
      const threadId = await creator.createIdleThread(options);
      await creator.stop();
      if (closed) return;
      // Expose the binding before submitting the first turn; shutdown drains
      // system events and flushes the catalog for snapshot-sync recovery.
      yield { type: 'system', threadId, cwd: options.cwd,
        model: options.model, reasoningEffort: options.reasoningEffort };
      if (closed) return;
      task = createCodexQueueRun({ ...options, threadId });
      yield* task.events;
    } catch (error) {
      if (!closed) yield { type: 'error', terminationReason: 'failed',
        message: `Codex 首轮提交失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      await creator.stop();
      settled = true;
      settle();
    }
  })();
  const close = async (cancel: boolean): Promise<void> => {
    if (settled) return;
    closed = true;
    if (!started) { settled = true; settle(); return; }
    if (task) {
      if (cancel) await task.stop();
      else await task.detach!();
    }
    await completed;
  };
  return {
    runId: options.runId, events,
    stop: () => close(true),
    detach: () => close(false),
    waitForExit(timeoutMs) {
      if (settled) return Promise.resolve(true);
      return Promise.race([completed.then(() => true),
        new Promise<boolean>((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); })]);
    },
  };
}
