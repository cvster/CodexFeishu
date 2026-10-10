# Codex 提交与回复解耦 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复旧回复观察器阻塞群消息的问题，安全恢复积压消息，并部署同一版本到本机和 pc。

**Architecture:** 为 Codex 增加只等待接收确认的提交接口；复用现有权限流程、原子状态存储和唯一回复同步器。公开共享端点可用时走队列 RPC，否则在发送前选择 CLI；确认不明时禁止自动重发。

**Tech Stack:** TypeScript、Node.js、pnpm、Vitest、公开 Codex app-server JSON-RPC、官方 Codex CLI、飞书 SDK。

**Spec:** `docs/superpowers/specs/2026-10-10-codex-submission-reply-decoupling-design.md`

## 执行记录

2026-10-10：Task 1–4 已实现。独立审查发现的三项 Important 已以失败→通过测试修复：接收确认不等待全局回复同步、正常断开保留未发送收件、附件恢复失败明确拒绝并检查所有本地路径。

整体验证：810 项通过、1 项跳过；类型检查和构建通过；网页适配器 34 项通过。远程 pc 公开队列只读探测成功。

用户最新要求“旧消息丢掉”，覆盖 Task 5–6 中旧积压恢复/导入步骤：5 条未提交的 AA-ota-driver 旧消息不补发，恢复工具不交付。新收件持久化及 unknown 不重发保护继续保留。

本次直接在既有 main 交付，不再询问执行方式，不创建 PR；仅推送 codexfeishu/main。部署验收单独记录，不由只读审查代替。

## Global Constraints

- 保留现有消息合并与约 600ms debounce。
- 已确认对应轮次结束的记录保留 7 天后清理，未确认或未完成的记录不自动删除。
- 本次不改 Claude 执行流程，不重构网页适配器，不增加私人 IPC，不重启桌面 App 或共享 app-server。
- 同步器断线、读不到轮次或桥接重启，都不自动停止 Codex 任务，也不盲目重发消息。
- 已归档会话不创建替代会话或新群，沿用既有提示。
- 两端代码保持一致，按能力动态选择连接方式。
- 提交并推送 `codexfeishu/main`，不得推送 `origin` 或强制推送。
- 重启前检查桥接、真实 app-server 和 OS 进程；其他会话活动时取得用户确认。

## Review Focus

- 接收结果写盘失败：视作需要核对的未知提交，不自动重试。
- 同群在提交等待期间归档或重新绑定：发送前校验原绑定，禁止投递到新线程。
- 图片/文件消息恢复：沿用原消息 ID 和附件处理，文件不可读取时明确失败，不静默丢附件。
- 原生队列能力在探测后失效：发送错误分类不能触发第二次 CLI 提交。
- 连续停止、服务断开与快速完成同时发生：取消只作用于明确的 queue/turn ID，不卡住其他群。

---

## 文件与边界

- `packages/codex-core/src/submission.ts`（新增）：提交类型、能力探测、RPC/CLI 接收结果及取消助手；不观察回答。
- `packages/codex-core/src/thread-client.ts`、`index.ts`：增加类型化队列方法，导出新增接口；保留已有调用兼容。
- `src/agent/codex/submission.ts`（新增）、`adapter.ts`、`src/agent/types.ts`：适配器提交接口，创建/绑定空闲新线程；旧 `run()` 保留给既有消费者。
- `src/session/codex-submissions.ts`（新增）：每 profile 的持久化收件与提交记录，状态恢复与去重。
- `src/bot/run-flow.ts`、`src/runtime/run-executor.ts`：共享原有授权/绑定解析；新提交通道只在准备和提交期间占有 scope/pool。
- `src/bot/codex-turn-sync.ts`、`src/session/codex-origin.ts`：提交基线、ID 关联、唯一回复交付和完成尾部收敛。
- `src/bot/channel.ts`、`pending-queue.ts`、`src/commands/index.ts`：接入持久收件、独立提交、恢复与停止；不重构无关渲染。
- `tools/recover-codex-backlog.mjs`（新增）：一次性恢复清单的只读核对与显式导入，不读取/输出密钥。

### Task 1: 公开队列提交传输

**Files:** 新增 `packages/codex-core/src/submission.ts`；修改 `thread-client.ts`、`index.ts`；新增 `tests/unit/session/codex-submission.test.ts`、`tests/process/codex-submission-client.test.ts`。

**Interfaces:**

- `CodexSubmissionInput = { submissionId: string; clientUserMessageId: string; threadId: string; prompt: string; images?: readonly string[] }`。
- `CodexSubmissionResult` 为 `accepted | rejected | unknown` 判别联合：共有 `submissionId/threadId/transport`；accepted 有可选 `queueId/clientUserMessageId`；其他结果有 `message`。
- `QueuedCodexSubmission = { id: string; clientUserMessageId?: string; input: unknown[] }`。
- `CodexThreadReader.listQueuedSubmissions(threadId: string): Promise<QueuedCodexSubmission[]>`，处理分页；`addQueuedSubmission(input: CodexSubmissionInput): Promise<QueuedCodexSubmission>`，只允许 sharedServer。
- `CodexSubmissionTransport = { shared?: Pick<CodexThreadReader, 'connect' | 'listQueuedSubmissions' | 'addQueuedSubmission'>; runCli(input: CodexSubmissionInput): Promise<{code: number | null; stdout: string; stderr: string}>; beforeSend(transport: 'rpc' | 'cli'): Promise<void>; timeoutMs?: number }`；默认提交等待超时 30 秒。
- `submitCodexInput(input: CodexSubmissionInput, deps: CodexSubmissionTransport): Promise<CodexSubmissionResult>`；RPC 发送不自动重试，超时停止等待但不杀可能已提交的 CLI。

- [ ] 写测试：`rpc_acceptance_preserves_client_id` 断言 add 的输入原样、返回 queue ID 与 client ID；`unsupported_probe_uses_cli_once` 断言只执行一次 CLI。
- [ ] 写测试：`lost_rpc_ack_never_falls_back` 断言 add 超时返回 unknown 且 CLI 调用为 0；`cli_ack_without_turn_returns_immediately` 断言无轮次仍 accepted；`probe_race_does_not_double_submit` 覆盖探测后接口失效。
- [ ] 运行 `pnpm exec vitest run tests/unit/session/codex-submission.test.ts tests/process/codex-submission-client.test.ts`，确认新行为测试失败。
- [ ] 实现上述接口；先 connect/list 探测公开方法，不调用 queue/start；未知方法只在未发送 add 时降级。CLI 解析接收确认，捕获 spawn error、非零退出和超时，不将未知提交归为明确拒绝。
- [ ] 同命令通过；运行 `pnpm typecheck`，确认已有 core/web 使用方式兼容。
- [ ] 提交 `feat: add acceptance-only Codex queue submission transport`。

### Task 2: 持久化收件与提交账本

**Files:** 新增 `src/session/codex-submissions.ts`、`tests/unit/session/codex-submissions.test.ts`；修改 `src/bot/pending-queue.ts`，新增 `tests/unit/bot/pending-queue.test.ts`。

**Interfaces:**

- `CodexSubmissionRecord` 包含 submission ID、scope、NormalizedMessage 数组、原 thread/binding、prompt/images、client/queue ID、knownTurnIds、replyTo/replyInThread、created/updated/completed 时间。
- 状态：`pending`（未尝试发送）、`sending`（已落盘即将发送，重启按 unknown 处理）、`accepted`、`rejected`、`unknown`、`completed`、`cancelled`。
- `CodexSubmissionStore(path: string, now?: () => number)`；`load(): Promise<void>`、`receive(scope, message): Promise<boolean>`（message ID 去重）、`prepare(record): Promise<void>`、`mark(id, patch): Promise<void>`、`records(): CodexSubmissionRecord[]`、`flush(): Promise<void>`。
- `PendingQueue.snapshot(): Array<{scope: string; messages: NormalizedMessage[]}>` 仅返回待 debounce 批次，停止时先保全状态再清空计时器。

- [ ] 写测试：收件落盘后才能进内存调度；同 message ID 二次收件返回 false；同文本不同 ID 保留两条；600ms 内消息仍合并且 block/unblock 保持顺序。
- [ ] 写测试：sending 重载不自动恢复发送；accepted 重载仅供同步；pending 可以恢复；写盘失败阻止发送；completed 恰满 7 天可清理，unknown 过期也保留；恢复时缺失附件显式报错。
- [ ] 运行 `pnpm exec vitest run tests/unit/session/codex-submissions.test.ts tests/unit/bot/pending-queue.test.ts`，确认失败。
- [ ] 通过 `writeFileAtomic`、串行持久化实现状态更新，文件命名 `codex-submissions.json`、权限 0600；解析损坏文件时失败关闭，不静默清空再发送。
- [ ] 同命令通过；确认空状态文件和旧 profile 首次启动不报错。
- [ ] 提交 `feat: persist Codex message intake and submission recovery state`。

### Task 3: 统一同步器关联与事件补偿

**Files:** 修改 `src/bot/codex-turn-sync.ts`、`src/session/codex-origin.ts`；扩展 `tests/unit/bot/codex-turn-sync.test.ts`，新增 `tests/unit/session/codex-origin.test.ts`。

**Interfaces:**

- `CodexTurnSyncHandle.registerSubmission(record: CodexSubmissionRecord): Promise<void>`：在发送前保存基线、目标和 client ID，接收后可再次补充 queue ID。
- 同步器依赖可选 `submissionStore`，重启读入非终结关联；现有 `observeTurn(...)` 保持兼容。
- `isClaimedCodexBridgeTurn` 新增可选 client ID 参数；有 ID 精确判断，无 ID 只辅助来源分类，不返回任务完成状态。
- 共享 reader 通知触发同一 `runNow` 锁；保留 2s 快照补偿，避免事件/轮询两个并发卡片写入器。

- [ ] 写测试：准备后、ack 前快速完成的轮次正常交付；相同文本不同 client ID 分别绑定；CLI 尾部换行不阻塞同步；未知来源不重复回显飞书输入。
- [ ] 写测试：poll/event 并发只建一个卡片；完成事件与最后文本交错仍完整；reader 断线不改成已中断；notLoaded 不冒充权威终态；重启恢复交付记录不补发旧回答。
- [ ] 运行 `pnpm exec vitest run tests/unit/bot/codex-turn-sync.test.ts tests/unit/session/codex-origin.test.ts`，确认失败。
- [ ] 实现提交关联、状态持久化迁移和共享通知；完成前处理已缓存内容，再由同一快照/持久终态验证收敛。没有共享端点时继续只读快照，不 resume 独立 writer。
- [ ] 同命令通过，现有归档、模型状态、名称同步测试通过。
- [ ] 提交 `fix: associate synchronized Codex replies by submission identity`。

### Task 4: 接入短生命周期提交流与停止控制

**Files:** 新增 `src/agent/codex/submission.ts`；修改 `src/agent/types.ts`、`codex/adapter.ts`、`src/bot/run-flow.ts`、`src/runtime/run-executor.ts`、`src/bot/channel.ts`、`src/commands/index.ts`；新增 `tests/integration/bot/codex-submission-flow.test.ts`，扩展 `tests/unit/runtime/run-executor.test.ts`。

**Interfaces:**

- `AgentAdapter.submit?(opts: AgentRunOptions, beforeSend: (prepared: {threadId: string; knownTurnIds: string[]}) => Promise<void>): Promise<CodexSubmissionResult>`；仅 Codex 实现。
- Codex 提交适配器为新会话复用 `createIdleThread`；先调用 beforeSend 保存新绑定与基线，再提交。保留 `run()` 兼容既有消费者，不让飞书走旧逐请求观察器。
- 从 `startRunFlow` 提取 `prepareRunFlow(input: StartRunFlowInput): Promise<PreparedRunFlowResult>`，成功结果包含 policy/cwdRealpath/resumeFrom/sessionId/threadId/model/reasoningEffort/images；失败联合沿用现有错误码。
- `RunExecutor.submitMessage(input: SubmitRunInput, beforeSend: (prepared: {threadId: string; knownTurnIds: string[]}) => Promise<void>): Promise<CodexSubmissionResult>` 使用 Task 1/适配器接口，在 finally 释放准备/提交占用；不注册一个持续回答生命周期的 ActiveRun。
- `startRunFlow` 仍调用原 `executor.submit`；Codex 飞书调用新的 prepared/submission 分支。收件时先 await store.receive，再 pending.push；恢复仅调度 pending，不重复调度 accepted/unknown。
- 停止助手优先实际 active turn ID；无 active turn 时仅删除账本中本 scope 已确认且仍在官方队列的 ID。查询失败或没有可靠 ID 时提示不能确认，不取消其他会话。

- [ ] 写测试：第一条 accepted 而回答仍运行时，第二条可以提交；永远没有对应轮次也能释放锁；两个群不互相阻塞；提交 unknown 不显示回答失败或自动重发。
- [ ] 写测试：提交前归档、等待 pool 时归档和换绑都拒绝；新线程基线/绑定先落盘再发送；beforeSend 写盘失败 add 调用为 0；ack 后写盘失败状态仍可恢复核对。
- [ ] 写测试：显式停止取消真实 ID；连续停止/断开/快速完成不误杀；服务断开只 flush 状态和观察器，不 interrupt/delete；控制台等非取消命令不丢弃已持久化待提交消息；原 Claude run flow 不变。
- [ ] 运行 `pnpm exec vitest run tests/integration/bot/codex-submission-flow.test.ts tests/unit/runtime/run-executor.test.ts tests/integration/bot/im-run-flow.test.ts`，确认失败。
- [ ] 实现上述接口并接入 channel；避免 `processAgentStream` 将接收结果归为 completed，避免 executor 的 post-done 清理取消已接收任务。提交异常文案区分明确失败与待核对，停止后的卡片仍交统一同步器更新。
- [ ] 同命令通过；运行 Task 1–3 的测试以及 `tests/process/codex-queue-adapter.test.ts` 确认旧兼容路径未被意外改变。
- [ ] 提交 `fix: release Feishu submission queues after Codex acceptance`。

### Task 5: 既有积压恢复、整体验证与交付

**Files:** 新增 `tools/recover-codex-backlog.mjs`、`tests/unit/session/codex-backlog-recovery.test.ts`；更新 core README 与本计划完成标记。恢复清单保存在 profile/备份目录，禁止纳入 Git。

**Interfaces:**

- 恢复清单格式 `{version: 1, entries: [{messageIds, scope, threadId, messages, disposition: 'already-submitted'|'pending'|'ambiguous', evidence}]}`。
- 工具默认只读报告；`--import <manifest>` 只导入明确 pending，按 message ID 去重；ambiguous 不提交；已提交项只记录关联，不重放。

- [ ] 写测试并运行 `pnpm exec vitest run tests/unit/session/codex-backlog-recovery.test.ts`：pending 顺序、已提交跳过、相同文本不同 ID、ambiguous 拒绝自动导入、清单绑定改变/已归档拒绝导入。
- [ ] 实现工具；对两端异常群核对旧日志、飞书历史及当前真实线程 rollout，形成清单。AA-ota-driver 的旧已完成请求不重发；尚未提交的积压逐项确认。若存在 ambiguous，向用户列出后暂停该项，不阻挡其他确定项的代码验证。
- [ ] 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm test:web` 与 `git diff --check`；逐条记录通过输出或准确的失败限制，不宣称未运行的检查通过。
- [ ] 按执行方式安排独立代码审查，重点检查未知确认不重试、归档换绑竞态、停止和重启不误取消；修复发现问题并重跑对应测试。
- [ ] 提交整体验证/恢复工具及文档，`git push codexfeishu main`；检查工作树 clean。远程分歧时停止，不 force-push。

### Task 6: 两端部署与验收

**Targets:** 本机 `C:\software\lark-coding-agent-bridge` / scheduled task `LarkChannelBridge.Bot.codex`；pc `/home/pc/lark-coding-agent-bridge` / user systemd `lark-channel-bridge.bot.codex.service`。

- [ ] 重新检查两端真实 app-server 活动线程、桥接日志/运行登记、OS 进程树。仅当前 AA飞书桥接活动时可按已授权规则重启；其他活动任务先报告并等待确认。
- [ ] 备份 profile 状态、账本/恢复清单、当前源码与 dist，记录共享 writer PID；生成同一 Git commit 的部署包并核对目标绝对路径。
- [ ] 原子导入明确 pending 的恢复清单；如果旧服务仍可能消费这些消息，先保全清单，在停旧桥接之后再导入，防止双方重复发送。
- [ ] 只停止/替换/启动桥接服务和其拥有的只读客户端。Windows 启动保持隐藏，等待 profile 锁释放；Linux 不操作 app-server daemon 服务。
- [ ] 校验两端运行版本、dist/core 哈希、服务运行状态、飞书长连接和最近日志，确认共享 writer PID 没因部署被替换。
- [ ] 核对积压记录状态与官方队列/轮次；在用户授权测试会话发送连续两条消息，确认第二条无需等待首轮完成、正文完整且不生成双卡片。未获测试发送授权时，使用用户自然发送的消息完成验收，不自行向其他会话发任务。
- [ ] 异常时回滚桥接代码但保留账本，不重放 accepted/unknown；报告已部署版本、两端状态、恢复结果及仍需人工确认的消息。

## 计划自审

Task 1 覆盖传输与能力降级；Task 2 覆盖持久化与重启恢复；Task 3 覆盖统一回复和 ID 关联；Task 4 覆盖调度、权限与取消；Task 5–6 覆盖旧积压及部署安全。公共接口均为新增或兼容扩展，运行态数据不进入 Git，没有用“接收成功”替代“轮次完成”。
