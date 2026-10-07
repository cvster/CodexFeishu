# Feishu bridge adapter

The existing root `src/`, `tests/`, `bin/`, `dist/`, and configuration paths remain
the Feishu service's compatibility layout. This workspace identifies its boundary
without moving a running service's startup path. Runtime imports under
`src/session/` delegate to `packages/codex-core`; cards, groups, access policy and
service lifecycle remain Feishu-only. The root CLI output is a standalone bundle.

Build/test from the repository root. This workspace does not start the web service.
