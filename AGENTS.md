# Operational safety

- Before stopping, restarting, replacing, or upgrading the running bridge, first check whether any Codex task is still active. Check both the bridge's active-run state when available and the operating-system process tree/logs; do not rely only on the bridge process registry.
- If any task is active, report the affected task/group and ask the user to confirm whether to interrupt it. Do not restart until the user explicitly confirms.
- If no task is active, the restart may proceed without an additional confirmation unless another instruction requires one.
