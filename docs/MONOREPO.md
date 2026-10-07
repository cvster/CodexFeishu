# Shared Codex core, independent services

## Repository boundaries

- `packages/codex-core`: MIT shared runtime: public app-server connection/RPC,
  reconnect and timeout handling, normalized thread snapshots, durable terminal
  verification, idle thread creation, fork naming, native queue arguments,
  endpoint discovery, model catalog and question/answer compatibility.
- `apps/feishu-bridge`: adapter workspace. For compatibility with installed services,
  its implementation and build entry still live in root `src`, `tests`, `bin`, `dist`.
  Feishu events, cards, group operations, profiles and service lifecycle stay here.
- `apps/web-app`: independently deployed web adapter, including UI, authentication,
  files, nginx and upstream overlay scripts. It does not import Feishu code.

The shared runtime is code reuse, not a new central daemon. Local and PC services
keep independent processes, credentials, configs and start/stop operations. Each
adapter attaches to a public shared Codex endpoint when available; otherwise it
uses a read-only observer. New threads are persisted first, then all web messages
and existing Feishu-thread messages enter the official native queue. No competing
embedded `thread/resume` fallback is used for queue delivery.

Closing an observer does not interrupt a writer or delete queued input. An observer
timeout means observation failed, not that the task ended. Explicit Stop/Archive
remains a user action. Pending native questions can only be answered through an
accessible original/shared writer; a private Desktop endpoint is not bypassed.
The existing Feishu async-question warning/answer support is preserved. Web question
UI is not added by this extraction.

## Build and verification

Run from the repository root (Node >=20.12, pnpm):

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm exec vitest run --maxWorkers=2 --minWorkers=1
pnpm test:web
```

`pnpm build` builds the Feishu service plus a standalone core artifact and prepares
the web overlay's `server/codex-core` and browser-safe shared model module. Generated
core files are ignored by Git; always build before applying web overrides. The web
upstream/vendor tree and its own dependencies still have to be installed according
to `apps/web-app/README.md`. Apply its overrides and build its UI independently.
The Feishu npm package does not include the GPL web adapter.

This code change does not move or update either running deployment. Deployment is a
separate operation: back up service configs, check bound active tasks and OS/logs,
then update only the intended service. Never restart a shared Codex writer daemon
as part of an adapter update. Do not copy credentials or runtime databases into Git.

## Compatibility retained

The Feishu history adapter now uses the shared RPC client while retaining its
preview formatting and typed errors. Remote archival still uses official CLI
`archive --remote`. Web archival prefers the discovered public shared endpoint;
its pre-existing state-store fallback for writer-conflict archival remains in
the GPL adapter and is not promoted to core. Rollout terminal verification is a
centralized compatibility fallback, not a second UI-specific status algorithm.
Static model lists are UI fallback choices, not account entitlement; execution is
validated by the server. Existing per-service default models/effort are unchanged.

## Provenance, licenses and local files

Web history was imported with an unsquashed Git subtree from the committed
`mobileCodexHelper` master at `f6dd303`. Its original directory is untouched,
including uncommitted hidden-launch script changes. Vendor code, `.env`, runtime
logs, databases, dependencies and generated files were not imported.

Root/Feishu and shared core retain MIT licensing. `apps/web-app/LICENSE` retains
GPLv3, with its imported notices and history. Root MIT is not a relicensing of web
code. Shared core bundles its MIT/ISC dependency license texts into the standalone
artifact. Keep both license boundaries and notices when distributing artifacts;
the workspace packages are private and no package is published by this change.

Public protocol reference: https://learn.chatgpt.com/docs/app-server

## Verification of this extraction (2026-10-07)

- Windows: bridge 757 passing tests, one opt-in live test skipped; web 34 passing
  offline tests; typecheck, core/bridge build and frozen lockfile install passed.
- Linux PC: the same 34 web/core adapter tests passed in an isolated `/tmp` tree
  using Node 24.20.0. The running deployment and Codex writer were not changed.
- Full upstream/vendor UI build and authenticated live inference smoke tests are
  not included in these checks. Validate them when staging a separate deployment.
