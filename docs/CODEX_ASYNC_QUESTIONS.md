# Asynchronous Codex questions

This feature does not change native `item/tool/requestUserInput` handling.

## Read and display

The existing two-second turn synchronizer passes reconciled `thread/read`
snapshots to the input-card coordinator. Structured `agentMessage.questions`
create a separate interactive form; Markdown lists are never interpreted as
questions. Only the latest in-progress turn is eligible. Persisted identity is
`(threadId, turnId, itemId, bound scope)`, with the existing opaque callback token,
message identity and group-access validation.

Desktop-compatible question IDs are stable by source item and question index.
Accepted structured user answers close their question controls. A partial
Desktop answer does not close the remaining controls or renumber form fields.
Turn completion or a newer turn closes the old form. Historical questions are
not replayed when the bridge starts.

## Submit

For a bridge-created turn, use its existing stdio app-server connection. For an
existing Desktop turn, use the shared writer app-server selected by
`CODEX_QUEUE_REMOTE` (or the default daemon proxy). Read its live turn again
before submitting, then call public `turn/steer` with `threadId`,
`expectedTurnId`, `clientUserMessageId` and one text input. Verify the returned
turn ID. Never fall back to `thread/resume`, `turn/start`, `codex queue`, or
Desktop's private IPC to deliver an answer.

The structured answer text envelope is Desktop-specific compatibility, not a
documented app-server answer API. Parsing, question IDs and serialization are
isolated in `src/session/codex-async-input.ts` and covered by tests. It matches
the installed Desktop implementation: `questionItemId`, original `question`
and chosen/custom `answer` inside `send_user_message_question_reply` tags.
The public transport contract is documented at
https://learn.chatgpt.com/docs/app-server#steer-an-active-turn.

No answers are saved in bridge state. Submission is reserved before sending;
simultaneous clicks cannot both submit. If an acknowledgement is lost, the
card is disabled with an explicit unconfirmed status; snapshots or terminal
state can resolve it, but reconnect/restart never automatically resends it.

## Operational boundary

A Desktop launched with a private stdio server may have no public endpoint for
an additional bridge client. Reading saved questions is still possible, but
answers cannot be steered into that running process through a separate server.
The card reports this limitation instead of claiming success. Connecting
Desktop and the bridge to the same publicly accessible app-server is a separate
startup/configuration change; this feature neither restarts Desktop nor creates
a competing daemon.
