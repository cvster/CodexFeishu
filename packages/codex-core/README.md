# Codex core

MIT-licensed runtime extracted from the Feishu bridge. It owns public app-server
transport, thread snapshots and operations, fork names, durable turn verification,
question parsing and answer formatting, and cross-platform Codex process resolution.
It does not depend on Feishu, web authentication, UI, or either service's configuration.

Each service creates its own client and retains its own config and shutdown lifecycle.
Closing an observer never interrupts a turn or deletes queued input. Native queue
execution belongs to the external writer. Only explicit Stop/Archive can cancel work.
