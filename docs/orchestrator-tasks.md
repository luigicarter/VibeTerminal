# Orchestrator conversations and tasks

The Orchestrator keeps one conversation and tracks each submitted request separately.
Text and voice requests are accepted while other work runs. Each message, question
and delivery receipt stays associated with its request and terminal.

## Automatic terminal assignment

Users can give a task and let the Brain choose its worker. `delegate_task` binds
the objective and project before a read-only routing stage inspects candidate
conversations. Related work returns to its work item's owner, including while
busy; independent work uses a separate conversation. A new worker is created
without staged prompt text, checked for actual readiness, then receives a frozen
operator grant and one normal observed submission. Creation is never task delivery.

Related requests share a pending creation reservation. Automatic tasks wait for
conflicting managed work in the same canonical worktree without holding terminal
control lanes. Busy continuations retain their independent result-attribution
requirements. Clarification and deferred steps retain the original work item and
native conversation identity; a changed conversation cannot receive their input.
Known slow creation can recover the exact original launch without creating a
duplicate. Unknown prompt delivery remains non-replayable.

Task details show whether routing selected a new or existing agent and why.
Bounded work-item history is reference data and never restores live execution
authority. See [the routing implementation and investigation](orchestrator-routing-deep-dive.md)
for capability, persistence, context-budget and verification boundaries.

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
Submitted-task acknowledgements and semantic task-status lookups use the scheduler's
request/terminal/turn evidence. A successful input write with no attributed start
says that input was sent and the start remains unconfirmed. A live agent process,
an older completed turn, terminal prose and a model-authored `finish_terminal`
summary cannot promote that submission to running. Attributed completion says the
agent turn ended; it does not independently verify the requested changes.
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

An explicit free-terminal request retains an idle-only candidate group through
selection and admission. Availability is checked again before host input; it
cannot silently become a busy follow-up or queued send. A supported queued Codex
operator prompt can instead advance through fresh busy-composer observation when
the request permits busy delivery. Rejected and uncertain writes never replay.

Scheduler queue messages identify the owning request and workspace, including
unverified-result blockers. A continuation of a completely unstarted queued task
transfers its full pending authority and retires the original queue entry before
execution; failed or raced recovery cannot leave a second copy. Conflicting
project work still waits for attributable results. See the
[queued-prompt investigation and fixes](orchestrator-queued-prompts-investigation.md).

An already-working terminal can receive a followup prompt. For an observed Codex
root composer, `send_prompt` submits the text while the existing turn continues,
including during logical background/subagent activity. It rechecks the original
root PID, generation, turn and input revision; output-only churn cannot starve
this pure prompt path. Arbitrary keys, input editing, pending questions, manual
draft ownership and unverified recipients keep their existing guards. The app
never interrupts the agent or clears human input just to deliver a busy prompt.

Other native busy composers use the immutable prompt queue after a proven-unsent
readiness refusal. Queued prompts survive healthy work longer than two minutes
and can deliver on fresh readiness after application suspension. Cancellation,
replacement generations, pending questions, lost readiness and unresolved delivery
locks remain distinct. Unknown writes are never queued for automatic replay.
Fusion/Open Fusion keep their structured input/steering routes.

The actual prewrite baseline is installed before a transport can emit completion
events. Busy submission acknowledges input, not incorporation into the existing
turn: that turn's ending cannot satisfy the new followup's result dependency.
Without separate provider-linked result evidence, incorporation remains explicitly
unverified. `send_prompt` already submits its text; the model must not follow a
written/queued receipt with another Enter to make sure.

The configured Brain passed both `prompt-while-working` and `safe-clear-input`
in the disposable native-adapter live harness. Busy input left the agent running;
clearing emptied the fixture composer without exiting. The integrated regression
suite and hidden Electron/PTY checks cover routing, ownership and queue boundaries;
the live harness does not certify custom keymaps or every installed CLI version.

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

Failed interpretation and execution retain unconsumed work. A blocked operator
finish ends the attempt while retaining its target and original objective;
successful completion alone consumes the objective. Retry does not replay
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
can use Space or Hey Lina. Replies are spoken one at a time and defer to active
recording. The model uses `respond` with explicit `responseTurn` metadata: `listen`
opens a request-owned question and listens for an answer for fifteen seconds;
`complete` returns to standby; `dismiss` ends the voice exchange. `ask_user` also
opens an answer window. This covers conversational questions and user decisions,
without inferring intent from question marks. Silence returns quietly to standby
while retaining the question. Followup detection can run temporarily with wake
detection disabled; Space remains the fallback if detection is unavailable.
Native terminal questions retain their request, revision and generation checks.
Whole-utterance dismissal phrases such as “never mind” or “that's all”, and the
microphone indicator's X, dismiss voice without answering a question, granting
permission, cancelling terminal work, or changing the saved voice preference.

Saved conversation resume uses exact requested titles or IDs. If speech appears to
have misrecognized a listed title, the model must ask a canonical confirmation of
the title, project, provider, and applicable Claude home, bound to that conversation's
opaque reference and the unfinished resume grant. An explicit
affirmative answer to that current question confirms only that candidate. A stale,
unbound, or unrelated reply does not authorize substituting another saved chat.

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

## Progress and outcome reports

Users can say **“Watch Atlas and tell me when its current task finishes, including
what it did and any issues”** or **“Tell me when Atlas is ready.”** The interpreter
registers a read-only `watch_terminal` grant. Completion watches bind the selected
terminal generation and current turn; readiness watches wait for explicit observed
readiness, including after overlapping input makes task attribution ambiguous.
Ambiguous readiness does not establish a task result: it cannot supply an
accomplishment summary or release work that requires that result. Watching never
submits input, grants permission, interrupts work, or
occupies a terminal execution lane. Cancel the request to stop its watch without
stopping the terminal. An unregistered watch retained through clarification or
retry keeps its original turn. Restored watches remain paused after an app restart.

While the Orchestrator is enabled, live submitted tasks receive request-linked chat
reports for observed agent activity, input blockers, completion, interruption and
failure. Each terminal reports independently, so one failed terminal is reported
while sibling work continues. Repeated inventory refreshes do not repeat the same
report; a new input blockage can report again. Voice-origin requests also queue
spoken outcome and issue reports through the existing speech controller. Confirmed
whole-command completion uses one ding and `done`. The conversation view omits
routine completion and missing-result notices, and coalesces actual successful
results for the same identified terminal turn across requests. Request-owned
records remain intact; the visible result carries its associated request numbers.
Failures, unconfirmed delivery and questions remain visible, and failures still
speak, including before a multi-terminal or deferred command is fully complete.
Queued commands acknowledge only after all requested actions are confirmed. Input
questions retain their existing revision-bound interaction speech, avoiding a
generic blocker announcement after the user has answered. Chat reports do not
wait for earlier speech playback to finish.

If a prompt and a later Enter create separate delivery waits for the same
attributed turn, they produce one lifecycle notification per request, terminal,
generation and turn. Execution waits stay independent. Unattributed delivery
warnings, distinct failure reasons, new input-blocking episodes and different
turns remain distinguishable.

Overlapping voice requests watching the same attributed turn retain their own chat
history. Saved report categories and terminal-turn identity preserve the display
projection after restart. Legacy stock completion/missing-result notices are
hidden only for their known automatic message origin; arbitrary old messages and
messages without enough identity are not merged. Routine completion and result
speech is suppressed independently of
the whole-command acknowledgment; matching failure reports and result summaries
share speech per attributed turn.
A new turn can announce again. Cancelled, silent or failed speech does not consume
the announcement for another still-active request; distinct failure explanations
remain separate.

Turn-end events are reconciled immediately so a newer terminal turn cannot hide
the earlier completion between inventory refreshes. These event snapshots do not
replace the live inventory or change unrelated terminals' readiness.

Status reports use application-owned delivery and turn evidence and need no Brain
call or optional monitoring setting. They continue while prompts or lookups queue
and when a model spending limit prevents further inference. Optional model summaries
can run while requests wait in terminal queues; they include turn-state changes,
and failed reads or incomplete summaries remain eligible for another lookup.

Watch start, resumed work, and input blockers can also queue a short progress
summary of available output, the last reported tool/activity, and current questions.
Unchanged polls do not repeat reports. Summaries are discarded when the terminal,
turn, or blocker changes while the model is responding. They have no action tools.

On completion, an independent bounded queue asks the selected Brain to summarize
the exact turn's captured result: accomplishments or findings, reported checks,
and unresolved work. The status notification does not wait for this summary or
for speech playback. Late result evidence can add the summary afterwards. A ready
terminal receives an accomplishment summary only when an actual completed turn's
evidence is also available. The app never treats startup readiness as completed work.
Detailed summaries honor the session spending limit. If a model cannot summarize,
structured agent output can be shown as an attributed excerpt; ambiguous native
screen content receives an explicit unavailable-result explanation. These are agent
reports, not independent verification of changes. Plain shells and idle screens
do not establish task completion. Voice-origin final summaries use the existing
queued speech channel; progress details remain in chat and native questions retain
their own current-interaction speech.

A queued prompt uses the observation immediately before its actual write for
result attribution. An intervening terminal turn cannot satisfy its wait using the
old queue-time observation. Ambiguous input/result attribution reports uncertainty
without unlocking dependent work. If accepted managed-agent input has no attributed
start after sixty seconds, the next inventory refresh reports that completion is
still unverified; this does not fail, replay or release the task. Plain shells
explicitly report the lack of automatic completion verification. Observed agent
turn completion never means changes were independently verified. Cancelled requests
and restored history do not emit new lifecycle reports.

Regression coverage lives in `orchestrator-task-reports.test.cjs` and
`orchestrator-task-report-integration.test.cjs`, alongside scheduler, delivery and
voice-turn tests. The hidden Electron command smoke uses a declared 128k fixture
model context and real preload/PTY delivery; it does not validate a live model or
physical microphone.

The configured Brain passed the `watch-existing-work` live scenario in
`scripts/qa/orchestrator-conversation-live.cjs`: it registered a watch from natural
language, reported progress, and summarized the exact completed turn's findings
and 12 passing tests, with no terminal input dispatched. This used disposable
terminal adapters. It does not establish live installed-provider telemetry or
physical microphone behavior.

Run `npm run test:orchestrator`, `npm run test:voice:capture`, and
`node scripts/frontend/orchestrator-tasks-smoke.cjs` for offline regressions. The task
integration tests cover native/structured completion evidence and shared-worktree
identity. The isolated Electron command smoke exercises real preload/IPC and PTY
delivery. The live task evaluation uses the configured Brain with disposable session
adapters; the configured Brain passed four of four live cases without sending work
to the user's terminals. Neither synthetic audio nor
scripted provider fixtures establish physical microphone or live coding-agent behavior.
