# Restart-resilient Codex runs

## Goal

A restart or crash of the Feishu bridge must not terminate an active Codex
turn. After the bridge reconnects, it must resume consuming the run's events,
continue updating the same Feishu card, and persist the resulting Codex thread
binding exactly once.

This design covers bridge restarts and bridge upgrades. A machine shutdown or
a crash of the task runner itself is a separate failure boundary.

## Why the current process model cannot recover

`CodexAdapter` currently spawns a per-run `codex app-server` process for a new
thread. Existing Desktop threads are submitted through the shared Codex daemon
with `codex queue`, while a read-only app-server client polls their results.
These processes still use pipe-backed stdin, stdout, and stderr.
`startChannel().disconnect()` calls
`activeRuns.stopAll()`, which sends SIGTERM and eventually SIGKILL to every
Codex child. All active-run state, event fan-out buffers, card rendering state,
and concurrency reservations are held in bridge memory.

Simply setting `detached: true` is not sufficient:

- pipe-backed stdout/stderr still depend on the parent;
- a new bridge cannot attach to the old pipes;
- card and event cursors would be lost, causing gaps or duplicate updates;
- cancellation and per-scope concurrency would become unreliable;
- Windows service managers may keep descendants in the same Job Object.

## Target architecture

Split the current process into two independently managed roles:

1. **Gateway**: owns Feishu WebSocket/REST, commands, policy evaluation,
   attachments, and card rendering.
2. **Runner**: owns Codex child processes, concurrency, cancellation, event
   translation, and the durable run journal.

```text
Feishu <-> gateway <-> local authenticated IPC <-> runner -> codex children
                 |                              |
                 |                              +-> durable run/event journal
                 +-> durable delivery/card cursor
```

The normal `restart` operation restarts only the gateway. The runner remains
alive and continues draining every Codex stdout/stderr stream.

## Runner protocol

Use a same-user local transport:

- Windows: named pipe;
- macOS/Linux: Unix domain socket;
- authenticate every connection with a random profile-local token stored with
  user-only permissions.

Version the protocol from the first implementation. Required operations:

- `submit(runSpec) -> runId`
- `listRuns(status?)`
- `subscribe(runId, afterSeq)`
- `cancel(runId)`
- `wait(runId, timeoutMs)`
- `drain()` and `health()`

Every emitted `AgentEvent` receives a monotonically increasing `seq`. The
runner appends the event to disk before publishing it over IPC. Subscribers can
therefore reconnect with `afterSeq` without losing or duplicating an event.

## Durable state

Keep the runner as the only writer of its state, avoiding cross-process file
locks. A profile may use the following layout initially:

```text
profiles/<profile>/runs/
  index.json
  <runId>/
    spec.json
    state.json
    events.jsonl
    stderr.log
```

`state.json` contains at least:

- run ID, scope ID, PID and lifecycle state;
- cwd, model, reasoning effort and sandbox mode;
- source session/thread ID and the thread ID discovered from Codex;
- last event sequence and terminal reason;
- created, started and finished timestamps.

The prompt must not be retained after the worker has accepted it. If short-term
durability is needed for the submit handshake, store it in a user-only file and
delete it immediately after Codex stdin is closed.

The gateway separately persists a `RunDelivery` record:

- run ID, chat/thread/message IDs and scope;
- CardKit card ID and its next update sequence;
- last consumed runner event sequence;
- renderer checkpoint needed to rebuild `RunState`;
- whether session-catalog finalization has been applied.

Writes use the existing atomic-write utility. Event delivery and session
finalization must be idempotent.

## Restart flow

1. Gateway enters drain mode and stops accepting new runs.
2. Gateway disconnects from Feishu and closes runner subscriptions. It does
   **not** cancel runner jobs.
3. Gateway process exits; runner and Codex children continue.
4. New gateway connects to Feishu and the runner.
5. It loads all non-terminal `RunDelivery` records and calls
   `subscribe(runId, lastEventSeq)`.
6. Replayed events rebuild the renderer state and update the existing card.
7. On a terminal event, the gateway performs normal card finalization and
   session-catalog persistence, then marks delivery complete.

The runner is authoritative for whether a scope has an active run. This keeps a
new gateway from starting a duplicate task during recovery.

## Shutdown and upgrade semantics

- **Gateway restart**: never stops runner jobs.
- **Explicit user terminate**: gateway sends `cancel(runId)` to the runner.
- **Full stop**: default to drain with a bounded timeout; require an explicit
  force option to cancel active jobs.
- **Runner upgrade**: put the runner in drain mode, wait for zero active jobs,
  then replace it. Do not couple routine gateway deployment to runner restart.
- **Runner unavailable**: reject new work and show a recoverable status; do not
  silently fall back to direct child spawning.

## Implementation plan

### Phase 0: prevent avoidable interruption

- expose active-run count to service restart/stop commands;
- make normal restart enter drain mode and wait, or refuse with a clear active
  task list;
- add an explicit `--force-cancel-runs` path for emergency shutdown.

This reduces immediate risk but does not make a running turn survive a bridge
crash.

### Phase 1: runner boundary

- extract Codex process ownership and app-server event translation from
  `CodexAdapter` into a
  profile-local runner process;
- implement authenticated IPC and durable sequenced event journals;
- replace the direct adapter with an IPC-backed adapter;
- move process-pool and authoritative active-scope reservations into runner.

### Phase 2: gateway recovery

- add durable `RunDelivery` state;
- persist CardKit IDs, update sequences, and event cursors;
- recover and replay active runs during `startChannel()`;
- make session-catalog and final-card commits idempotent.

### Phase 3: operations

- register runner and gateway as separate OS-managed services;
- change `restart` to target gateway only;
- add `runner status`, `runner drain`, and orphan-run diagnostics;
- garbage-collect completed journals after a retention window.

## Acceptance tests

At minimum, automate these cases:

1. Kill and restart the gateway during Codex text streaming; Codex PID remains
   alive and the same card reaches `done`.
2. Restart during a tool call; tool output is replayed exactly once.
3. Restart after Codex terminal output but before session persistence; the
   thread binding is saved exactly once.
4. Send another message to the same scope during recovery; no duplicate run is
   started.
5. Terminate from the Feishu console after gateway recovery; runner cancels the
   correct Codex process.
6. Runner is unavailable; gateway fails closed and reports actionable status.
7. Gateway version changes while a run is active; protocol mismatch is reported
   without killing the run.
