# Orchestrator interpretation and architecture review

The subsequent [implemented harness overhaul](orchestrator-harness-overhaul.md)
extends this initial investigation with workspace execution, goal review and
folder/project lifecycle changes.

September 9, 2026. Investigation began at source and installed version 0.1.109.
The installed interpreter, target-review and intent modules matched source after
newline normalization. The changes below are local source changes; the installed
application, saved conversations and active terminals were not changed.

## The 18:26 Toronto incident

The latest voice request asked for a Codex to investigate full-screen pane height.
The first interpretation failed schema validation. Its single retry proposed an
existing conversation without user-selection evidence. The ownership guard
correctly rejected that target, but the first formatting repair had consumed the
only retry. The request returned a generic interpretation failure before routing,
creation or terminal input. This was a recovery-composition defect; it was not a
repeat of the earlier wrong-recipient write.

Evidence came from the local conversation, receipts and diagnostics. Raw model
arguments were not retained, so the exact unexpected field in the user's first
response is unknown. The regression uses a synthetic unexpected field to reproduce
the observed failure category and sequence. No private transcript is included here.

## Findings and implemented changes

1. **Two different validation stages shared one repair allowance.**
   Contract validation and semantic review now each permit one repair. Either
   stage failing again stops the request, even if the other allowance is unused.
   There are at most three interpretation attempts, with the existing single
   reasoning-budget widening retained. Target and draft-purpose reviews share the
   semantic allowance; adding more checks does not create unbounded retries.
   Earlier review constraints stay in subsequent repair instructions. A rejected
   task cannot be replaced by an empty pane or dropped action list.
2. **Interpretation was coupled to the main coordinator's mutable state.**
   `backend/orchestratorInterpreter.cjs` now owns interpretation payloads, plan
   validation, selection/purpose reviews and their recovery policy. It receives
   task lookup, model completion and diagnostic/redaction adapters. It has no
   terminal dispatch, scheduler mutation or routing-reservation capability.
   `orchestrator.cjs` wires those adapters and consumes the resulting plan.
   This is the first extraction, not a complete architecture migration.
3. **Interpretation retries did not recheck the session spending limit.**
   All model calls made by the extracted interpreter use one adapter that checks
   cancellation and the current spending limit, then records response cost.
   This prevents another interpretation/review call after a prior response reaches
   the limit; it does not reserve unknown future costs or provide an atomic
   spending cap across concurrent services.

## Remaining structural concerns

Existing separation is useful: scheduling, routing decisions, native observations,
continuation transfer, context budgeting and completion predicates already have
dedicated modules. File count alone therefore understates the real issue:
coordination and state ownership remain concentrated in the main closure.

Before this change the main file was approximately 229 KB. It remains about
213 KB. Its 551-line `executeRequest` still handles context resolution, admission,
assignment, the model/tool loop, recovery, final text, speech and completion state.
`doAction` spans 336 lines, and assignment preparation another 140. Many lines
contain multiple statements, so physical line counts understate the complexity.

| Boundary | Evidence and next scoped change |
| --- | --- |
| Task delivery versus command completion | `doAction`, `delegatedSubmissionFinishes`, `completedOperatorResponse`, `commandCompleted` and `executeRequest` jointly decide input, handoff and reporting. Extract an execution service with explicit delivery evidence and a separate finalization result. Preserve the distinction between written input, accepted work, ended turn and verified outcome. The previously documented direct-operator completion limitation remains unresolved by this change. |
| Assignment and task lifecycle | Scheduler jobs, assignment reservations, work items, conversation lineage and delivery waits are reconciled in the main closure. Extract their transition owner before moving individual callbacks. Test cancellation, restored history, delayed receipts and replaced generations together. This is an architectural risk assessment, not a newly reproduced race. |
| Reporting and voice | Final response construction, completion cues and asynchronous task reports consume overlapping state at different times. Feed immutable lifecycle snapshots to a reporting component so text, speech and cues share the same evidence. |
| Model contract reliability | The schema and normalization already share per-operation field definitions, but the configured model still sometimes returns invalid fields. Retain strict validation and measure held-out requests and combined failures. More files or a higher retry count alone cannot establish reliable interpretation. |

The next refactor should extract execution/finalization with a small input/output
contract, then lifecycle reconciliation and reporting. Avoid passing the entire
coordinator state into new modules: that would move files while preserving the
same coupling. Preserve generation, receipt, grant and uncertainty checks at each
boundary. No blanket claim of an error-free Orchestrator follows from this audit.

## Verification and limits

- **1,912 backend/voice tests passed**, including eight new regressions. New cases
  cover schema/selection failure in both orders, schema/draft-purpose failure in
  both orders, repeated-stage bounds, dropped work after a veto, and spending
  limits. Existing cancellation, network failure, ownership, continuation,
  dependency and submission tests remain active.
- Build and type checking passed. The existing Vite bundle-size advisory remains.
- The configured `inception/mercury-2.5` was tested with two scripted initial
  failures and live interpretation/routing/execution thereafter. One run returned
  invalid command fields again and stopped with zero effects. A second run passed
  with five live model calls, one creation and one complete prompt to the new
  worker, preserving the instruction to investigate without editing files.
  This demonstrates recovery through the actual model path, not a measured
  production success rate. Combined reported cost was $0.001900266.
- The live fixtures use synthetic projects, terminal inventory and adapters. They
  do not submit to the user's terminals or certify physical microphone behavior,
  real Codex startup, installed behavior or every model response.

Local evidence: `.tmp/orchestrator-interpreter-tests.log`,
`.tmp/orchestrator-interpreter-build.log`, and reports under
`.tmp/orchestrator-recovery-live/1788993177331-43632/` (repeated schema failure)
and `1788993212079-46864/` (successful recovery). The live harness now records
sanitized action field names to help identify future contract failures without
recording prompts or argument values.
