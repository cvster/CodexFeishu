# Codex tasks survive bridge restart

The standard runtime sends both first and follow-up messages through the
official `codex queue` entry point. The Desktop/shared writer owns execution;
bridge children only submit or read. First messages create idle history with
public `thread/start`, materialize it using `thread/name/set`, validate it with
`thread/read`, then close that creator before queueing. No bridge-owned
`turn/start` is used. The standalone CLI's compatible `legacy` history mode is
used for this idle preparation; `threadSource` remains `lark-channel-bridge`.
The group name replaces the temporary title through existing name sync.

`AgentRun.stop()` means explicit cancellation. It still interrupts a running
turn or removes an accepted queued submission through the shared writer.
The history reader must not perform writer mutations, and its connection is
not closed before an in-flight cancellation acknowledgement.

`AgentRun.detach()` means bridge service exit/restart/reconnect. It stops only
observation. It never interrupts, deletes the queued submission, or kills the
submission client while its acknowledgement is in flight. `ActiveRuns`
marks it detached, not interrupted; stream/executor cleanup must not issue a
fallback stop or publish a false terminal state. System metadata is drained
and the session catalog is flushed before exit. The existing snapshot
synchronizer recovers live output on startup without resubmitting input.

This preserves tasks already accepted by Codex, not unsubmitted in-memory
message batches. It does not survive stopping Desktop/the writer, rebooting
the host, or an independent writer failure. If no official queue writer is
available, submission fails explicitly; there is no stdio execution fallback
in the standard runtime. Deprecated library compatibility flags can still
select non-durable stdio/exec, and non-Codex adapters retain their previous
shutdown behaviour. Operational restart checks in `AGENTS.md` still apply.

Verification includes process fixtures for accepted first/follow-up tasks,
non-cancelling detach, explicit cancellation, and executor cleanup. An opt-in
test uses an installed CLI with an isolated offline provider (no model call)
to verify idle history can be read by a new process after the creator exits:
set `CODEX_IDLE_TEST_BINARY` and run
`pnpm test tests/process/codex-idle-materialization.test.ts`.
