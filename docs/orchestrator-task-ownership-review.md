# Task ownership and existing-terminal selection

September 9, 2026. Source and the inspected installed package were 0.1.108 before
this repair. The installed package and the user's saved conversations were not
changed. No private transcript or credentials are included here.

## Observed request

The 14:14 Toronto request asked a Codex in the Vibe Terminal project to repair
full-screen panes that filled the width but remained short vertically. It reached
the existing product-discussion conversation. The saved receipts show a rejected
send before the required read, followed by one written send and a running-turn
report. There was no new-worker creation or task-assignment reservation. The
request subsequently reported an unfinished terminal operation.

The wrong recipient was selected during interpretation: a provider/project
description became an `operate_terminal` target. This bypassed the separate
`delegate_task` discovery and task-ownership checks. The later native read checked
input readiness, not whether this task belonged in that conversation. Recording
a new work item after submission could not prevent the incorrect initial choice.

## Contract and repair

- Independent work gets a new conversation by default. A matching project,
  provider, idle terminal or empty composer does not establish task ownership.
- Related work can continue with its verified owner, including while busy or
  after an earlier turn completes. Discovery can inspect a task the user started
  directly in a terminal even without an Orchestrator work-item record.
- Explicit named terminals, existing-terminal groups and user-selected panes
  remain usable, including when the user intentionally gives that agent different
  work. An explicit request for a fresh agent still requires creation.

`orchestratorTargetReview.cjs` adds a gate before newly interpreted existing-pane
task input. The application constructs selection candidates from names/aliases
actually mentioned in the current instruction, an explicit selected pane,
existing-group wording, a generation-matching reply target, or a current bound
interaction. Generic provider names alone are excluded. No candidate for an
operation means automatic rejection without a model approval call.

When candidates exist, a bounded read-only model review must cite application
evidence IDs covering every operation. Candidate matches do not themselves prove
intent: the review must distinguish genuine continuity, explicit reuse, topic
changes, creation requests and mixed clauses. Invented or incomplete citations,
malformed output and incomplete responses cannot approve input or silently
reroute an explicitly selected conversation; inconclusive reviews stop before
effects. A definite selection rejection gives the interpreter
its existing single repair opportunity to retain the complete objective and
provider/project constraints through `delegate_task`. It cannot replace rejected
work with an empty pane or drop all assignment work. Repeated identical reviews
are cached within the request; network failures and cancellation cannot reach an
effect. Diagnostics store the decision, not the review transcript.

Interpreter and router guidance now explicitly distinguish "a Codex in this
project" from selecting an existing conversation. The router requires same-task
continuity for automatic reuse; an unused composer alone no longer justifies
putting independent work in an existing terminal. Existing unfinished grants keep
their frozen authority and delivery history. This repair does not replay or move
the already-written user request.

The evidence gate is conservative eligibility checking, followed by semantic
review. It is not a complete natural-language parser or a guarantee that the
model will always identify task affinity correctly. Unsupported reference wording
falls back to assignment/interpretation repair rather than permitting arbitrary
existing-pane input. Existing-group recognition is currently English-oriented.

## Verification and limits

- **1,904 automated backend/voice tests passed**, including 15 new ownership
  tests. Build/type checking and the frontend routing smoke passed. The existing
  Vite bundle-size advisory remains.
- Scripted HTTP-path tests exercise rejection before input, creation and one
  complete send, same-task discovery, named/group selection, busy follow-ups,
  mixed requests, stale identities, missing evidence coverage, cancellation,
  network failure and attempts to bypass the assignment repair.
- The configured `inception/mercury-2.5` passed the natural provider/project
  request with an unrelated existing pane: one new worker and one send, with no
  input to the existing pane. The forced wrong-target proposal also passed through
  the actual application gate, real model repair and production router to one
  new worker and one send. Synthetic terminal adapters were used throughout.
- Separate live routing cases selected creation for unrelated idle work and
  explicit fresh review, and reused the owner for a busy continuation and a reply
  to an older task after another task. The paged-owner case exhausted discovery.
- Live runs also exposed nondeterministic schema failures before assignment and
  an existing direct-operator completion-reporting problem after correctly
  sending a follow-up. One explicit-existing case reached its model-call bound
  after one correctly targeted send. These are not certified as complete workflow
  successes. The final full-pipeline follow-up attempt failed interpretation
  before its second send; the offline follow-up regression passes. These limits
  remain separate from the reproduced wrong-recipient repair.

Local evidence: `.tmp/orchestrator-task-ownership-tests.log`,
`.tmp/orchestrator-task-ownership-build.log`; successful final new-work reports
under `.tmp/orchestrator-recovery-live/1788978842214-34136/` (natural request) and
`1788978753701-18020/` (wrong-target proposal); the separate router matrix under
`.tmp/orchestrator-routing-live/1788978396298-55056/`; final follow-up limitation
under `.tmp/orchestrator-recovery-live/1788978850145-58896/`.

The initial investigation ended at the source repair and local renderer build.
The subsequent user-authorized [0.1.109 release](release-0.1.109-review.md) records
installer and release acceptance. No update was installed automatically and no
work was sent to the user's terminals during verification.
