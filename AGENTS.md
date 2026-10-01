# Operational safety

- Before stopping, restarting, replacing, or upgrading the running bridge, first check whether any Codex task is still active. Check both the bridge's active-run state when available and the operating-system process tree/logs; do not rely only on the bridge process registry.
- The user has preauthorized restarting both bridge deployments when the only active bridge task is the current "AA飞书桥接" conversation (local Feishu chat `oc_9d3f3b2f62365ecec561dab10efd9646`). Announce the restart, but no additional confirmation is required in this specific case. This authorization does not extend to other conversations or unrelated Codex processes.
- If any other task is active, report the affected task/group and ask the user to confirm whether to interrupt it. Do not restart until the user explicitly confirms.
- If no task is active, the restart may proceed without an additional confirmation unless another instruction requires one.

# Delivery workflow

- After completing each user-requested feature or bug fix in this project, run the relevant checks, commit the related changes, and push to `codexfeishu` (`git@github.com:cvster/CodexFeishu.git`) without requiring another request. The current delivery branch is `main`.
- Keep unrelated user changes out of the commit. Do not force-push or silently resolve a remote divergence; report a blocked push or failed verification clearly. This standing authorization does not authorize additional deployments or service restarts beyond the operational safety rules above.
