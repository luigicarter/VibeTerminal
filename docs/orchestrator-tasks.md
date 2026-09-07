# Orchestrator conversations and tasks

The Orchestrator keeps one conversation and tracks each submitted request separately.
Text and voice requests are accepted while other work runs. Each message, question
and delivery receipt stays associated with its request and terminal.

## Ordering and context

The Brain resolves requests in submission order. Two execution model calls may run
alongside the routing call. Terminal waits do not occupy a model slot. Fully bound
simple commands use the existing action adapters directly; reading and reasoning
still use the workspace tool loop.

Requests for one terminal retain their order. Independent projects can progress
together. Managed agents that may write to the same Git worktree wait for earlier work; junctions
and subdirectories resolve to the same worktree identity. Explicit result dependencies,
such as reviewing a project before fixing the findings, wait for observed terminal
completion and read the result associated with that turn. A plain shell write, an
idle screen or a provisional agent response does not establish task completion.
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

Queued delivery, accepted input, saved drafts, observed results and unknown outcomes
remain distinct. A saved draft cannot satisfy a result dependency. Receipt IDs and
frozen terminal generations prevent repeated tool calls from sending a prompt twice.

Cancelling a request aborts pending model work and unsent delivery. It cannot retract
instructions already accepted by a terminal. Already-dispatched work remains relevant
to conflicting tasks until native completion or interruption is observed. Use an
explicit terminal interrupt when the terminal's own work must stop.

Failed interpretation and execution retain unconsumed work. Retry does not replay
consumed operations or uncertain deliveries. History reads validate opaque references;
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
adapters; it does not send work to the user's terminals. Neither synthetic audio nor
scripted provider fixtures establish physical microphone or live coding-agent behavior.
