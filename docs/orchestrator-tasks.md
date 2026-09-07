# Orchestrator conversations and tasks

The Orchestrator keeps one conversation and tracks each submitted request separately.
Text and voice requests are accepted while other work runs. Each message, question
and delivery receipt stays associated with its request and terminal.

## Ordering and context

The Brain resolves requests in submission order. Two execution model calls may run
alongside the routing call. Terminal waits do not occupy a model slot. Fully bound
simple commands use the existing action adapters directly; reading and reasoning
still use the workspace tool loop.

Active operator loops for one terminal serialize, while an operator may inspect,
answer or interrupt a busy terminal after an earlier loop has dispatched its work.
Operator lanes do not wait for that earlier coding task to finish. Ordinary sends
retain their readiness gates and result occupancy; explicit result dependencies
always apply. Independent projects can progress together. Ordinary managed-agent submissions that may write to the same Git worktree wait for earlier work; junctions
and subdirectories resolve to the same worktree identity. Explicit result dependencies,
such as reviewing a project before fixing the findings, wait for observed terminal
completion and read the result associated with that turn. A plain shell write, an
idle screen, `finish_terminal` or a provisional agent response does not establish
task completion. `send_prompt` and operator `terminal_interact` submissions marked
`inputPurpose: task` create result waits. Typing followed by a separate Enter binds
the wait at submission; interaction-only menu answers create no task-result wait.
Deferred review-then-fix work needs actual attributed result evidence, not merely
a finished operator scope.
Plain shells release scheduling lanes after ordered transport handling because their
completion cannot be observed reliably; they still cannot satisfy result dependencies.

The interpreter receives bounded recent user and assistant exchanges as context.
Current instructions and application-owned unfinished commands authorize actions.
Replies, terminal findings and restored history supply reference information, never
new permissions. Independent requests keep separate project context. Multiple
unanswered questions can coexist; **Reply** addresses one specific question.

Each request builds fresh model context from up to twelve recent exchanges and
compact task descriptors. The model-specific input budget reserves reply space and
uses a conservative UTF-8 byte bound. Unrelated task descriptors and older exchanges
shrink first; selected terminal identities and authorized instructions remain protected.
Old read-only tool exchanges can be retired without breaking tool-call pairing.
If the essential context still cannot fit, execution stops locally and retains
unfinished work. Saved history does not imply unlimited active model memory.

## Delivery, cancellation and recovery

Queued delivery, accepted input, explicit saved drafts, observed results and unknown
outcomes remain distinct. Delivery never falls back to saving a draft. A proven
unsent block reports its reason and `delivery: not-dispatched`; operator recovery
can read again and try a corrected step without retaining a nonexistent failed
terminal result. Unknown delivery remains tracked and cannot be replayed.

Drafts exist only on explicit request. Legacy staged receipts/history remain
readable: staged-only unsent work is paused, not waiting for a result; mixed work
retains actual outstanding delivery tracking before pausing. Neither drafts nor
paused history satisfy a result dependency. Receipt IDs, fresh single-use
observation tokens and frozen terminal generations protect dispatch identity.

Cancelling a request aborts pending model work and unsent delivery. It cannot retract
instructions already accepted by a terminal. Already-dispatched work remains relevant
to conflicting tasks until native completion or interruption is observed. Use an
explicit terminal interrupt when the terminal's own work must stop.

Failed interpretation and execution retain unconsumed work. Retry does not replay
consumed operations or uncertain deliveries. Persistent `operate_terminal` scopes
retain objective, targets and per-source execution accounting through clarification:
step receipts, the 128-step budget and uncertain submissions cannot be reset by a
continuation. Each new effect needs a fresh observation token and native input
revision; input ownership also persists across typed text and mouse drag steps.
History reads validate opaque references;
after a helper restart, a known reference can be refreshed using the exact original
provider, store, directory and native conversation ID. Unknown references require a
new listing, and stale paging cursors must restart at a valid page.

## Voice and saved history

Submitting voice input releases the microphone while the task runs. Further requests
can use Space or Hey Vibe. Replies are spoken one at a time and defer to active
recording. After an Orchestrator clarification, hands-free mode listens for an answer
for fifteen seconds. Silence returns quietly to wake mode while retaining the question.
Ordinary replies do not automatically open an answer window. Native terminal questions
retain their existing request, revision and generation checks.

Chat and public task outcomes are stored in `orchestrator-conversation.json` under
Electron userData, bounded to thirty days and ten MiB. Credentials, grants and live
dispatch state are excluded. Unfinished history restores as paused; restoring the app
never starts terminal work. Clear history removes saved conversation context.

## Interfaces and verification

`enqueue(input)` acknowledges acceptance with a request ID. The compatibility `send`
method returns the eventual relay result. State events expose tasks and request-linked
messages/receipts. `replyToRequestId` and `questionId` identify a clarification response;
`cancel({requestId})` and `retry({requestId})` operate on one task. Cancellation without
a request ID cancels Orchestrator requests together. Internal continuation metadata is
not part of the public submission interface.

Run `npm run test:orchestrator`, `npm run test:voice:capture`, and
`node scripts/frontend/orchestrator-tasks-smoke.cjs` for offline regressions. The task
integration tests cover native/structured completion evidence and shared-worktree
identity. The isolated Electron command smoke exercises real preload/IPC and PTY
delivery. The live task evaluation uses the configured Brain with disposable session
adapters; the configured Brain passed four of four live cases without sending work
to the user's terminals. Neither synthetic audio nor
scripted provider fixtures establish physical microphone or live coding-agent behavior.
