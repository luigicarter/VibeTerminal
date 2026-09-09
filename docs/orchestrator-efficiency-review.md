# Orchestrator efficiency and tool knowledge review

Reviewed September 8, 2026 against the current working source. This review covers
intent interpretation, conversation assignment, workspace tools, context sizing,
execution, and continuation. It uses source inspection and disposable scripted
providers; it does not claim live-model latency, cost, or decision-quality gains.

The strongest immediate improvements are better use of tools already present,
less repeated context, and consistent enforcement of unfinished work. A separate
goal-evaluation loop is needed for the larger step from tracking agent results to
deciding whether those results satisfy the user's objective.

## What the model can actually do

There are three separate model contracts, not one agent with unrestricted access:

| Stage | Model tool | Responsibility and bounds |
| --- | --- | --- |
| Interpretation | `interpret_workspace` | Convert the user's request into validated, frozen grants and dependencies. Does not execute terminal input. |
| Assignment, when needed | `route_workspace_task` | Discover an appropriate conversation, then choose reuse/create/clarify. Eight rounds, up to four reads per response; `choose` must be alone. Known verified task owners can bypass this model stage. |
| Execution | `workspace` | Execute only the operations exposed for this request's grants. Up to six calls per response; 32 operator rounds or 12 ordinary rounds, followed by finalization without another executor call when ready. |

The workspace contract contains 33 operation kinds. Each request receives only
the applicable effects, alongside read and response tools:

| Capability | Operations | Efficient use |
| --- | --- | --- |
| Live workspace | `list_roots`, `list_sessions`, `read_session` | Reuse supplied identities; read the relevant live target for fresh output, questions, navigation guidance, and action evidence. Listing a directory does not replace an observation token. |
| Saved conversations | `list_conversations`, `read_conversation`, `search_conversation`, `resume_conversation` | Discover a reference; search within that conversation; page only relevant text. Resume requires the requested or confirmed identity. |
| Files and completed work | `search_files`, `list_work` | File search matches names, not contents. Work history contains durable status/result excerpts, including closed terminals. Neither is a general repository-reading tool. |
| Terminal input | `send_prompt`, `stage_draft`, `terminal_interact`, `answer_question`, `permission` | Prefer the task-submission or structured-answer operation. Use native controls for actual menus/edits. A draft is unsent. |
| Observation and interaction closure | `watch_terminal`, `finish_terminal` | Register an authorized wait for existing work, or close an observed interaction. Finishing an interaction does not independently verify delegated work. |
| Navigation and lifecycle | `navigate`, `focus_session`, `create_session`, `interrupt`, `restart`, `close` | Focus only when the user workflow needs it. Creation text is staged, not automatically submitted work. Respect lifecycle scope. |
| Projects and setups | `create_project`, `add_project`, `list_setups`, `read_setup`, `launch_setup`, `save_setup` | Discover only missing setup information; execute bound project/setup changes. |
| Preferences | `list_preferences`, `remember_preference`, `forget_preference` | Reuse supplied preferences; changes require grants. |
| Conversation | `ask_user`, `respond` | Ask for missing information or authority; finalize with the appropriate response turn and optional spoken summary. These controls end a batch. |

Sources: [tool schema](../backend/orchestratorToolSchema.cjs),
[scoped tool guide](../backend/orchestratorToolGuide.cjs),
[intent contract](../backend/orchestratorIntent.cjs),
[routing contract](../backend/orchestratorRoutePlanner.cjs), and
[dispatcher](../backend/orchestrator.cjs).

## Findings and changes made in this review

1. **Tool availability did not convey enough operational knowledge.** The compact
   schema retained argument constraints but dropped descriptive prose. The system
   prompt described common actions, but omitted batching, filename-only search,
   several paging/retry rules, and effective read limits. Added a concise catalog
   generated from the exact scoped schema. Missing guidance for a newly exposed
   operation now fails explicitly instead of silently advertising an unexplained
   tool. Routing guidance now also explains its four-read batch and single-choice
   contract.

2. **The model could use more API round trips than the protocol needs.** Existing
   `tool_calls[]` are executed in order. The guide now teaches batching independent
   reads and already-evidenced effects. A send and its post-action read can share a
   response. An effect requiring the token from that read must wait for its result.
   No new unrestricted batch tool or parallel mutation mechanism was added.

3. **A reason-mode request could stop after only one requested action.** Reproduced
   with two focus grants: the model focused A, replied that A was focused, and the
   request returned successfully while B remained unfinished. The completion guard
   exempted partially executed legacy requests. Removed that exemption. The loop
   now prompts for remaining actionable work, while retaining explicit questions,
   blocked targets, uncertain-write protection, and bounded refusal handling.

4. **An early response control could leave an invalid tool exchange.** The runtime
   recorded all announced calls, then broke after `respond` or `ask_user`, leaving
   later calls without results. An unfinished-work retry could send that malformed
   exchange to the provider. Later calls now receive explicit skipped/not-dispatched
   results without executing or consuming grants. They require a new call if still
   needed after continuation.

5. **Directories repeated provider help for every terminal.** Added an internal
   compact-summary option and enabled it for interpretation, routing, initial
   execution context, and model `list_sessions` reads. Identity, state, filtering,
   and pagination remain available. `read_session` still supplies the full provider
   guide, and default non-model summaries retain it.

6. **Schema limits exceeded actual model read allowances.** Model `maxChars` now
   advertises 4,000, `list_work.limit` at most 10, and
   `search_conversation.limit` at most eight. Other directory limits retain their
   existing capacity. These are ceilings: the serialized context allowance can
   further shorten an excerpt and returns explicit continuation instructions.

7. **Success on the last permitted round could be reported as failure.** A final
   `respond`, `ask_user`, or verified operator `finish_terminal` needed another
   loop pass to publish. The loop instead threw its action-limit error. It now
   permits one finalization-only pass with an explicit guard against another
   executor call. Unfinished requests and exhausted reads still stop at their
   original limits.

## Measured effects and limits

| Check | Result |
| --- | --- |
| Identical 40-terminal Codex directory | 20,521 to 8,561 serialized bytes: 11,960 bytes removed, approximately 58%. This measures directory data, not the entire request or billed tokens. |
| Scripted single-target interaction | Separate read / send / read / finish takes four executor calls. Read / send+read / finish takes three, with the same single submission and post-action observation. |
| Including interpretation | The same scripted interaction takes five versus four total model calls, excluding routing and any later result summary. |
| Existing direct creation | Still one interpretation call and zero executor calls. This was already implemented before this review. |
| Added tool guide | 1,527 bytes for read-only scope; 2,530 for a normal operator scope. It adds useful instructions, so small workspaces do not receive the full directory-size saving. |
| Constrained 16K-context regression | The first guide draft caused a post-read context refusal. Compacting its prose restored the unchanged test to a 14,123-byte request within its 14,160-byte guard. No budget or user-instruction limit was raised. |

The benchmark explicitly scripts both sequential and batched plans. Both the
pre-review source snapshot and current source already execute the batched plan
in three executor calls. The new guidance makes that capability discoverable;
only a live-model evaluation can establish how often a model follows it.

The updated [offline benchmark](../scripts/qa/orchestrator-latency-bench.cjs)
records actual model-call counts, serialized input sizes, accepted effects,
held-acknowledgment behavior, and PCM before EOF. Its fixed 50 ms provider delay
is synthetic. Completion assertions now check truthful action receipts and the
existing concise `done` acknowledgment, rather than obsolete response wording.

Full-request before/after figures can also reflect concurrent source changes and
different fixture paths. The identical-directory comparison above isolates this
review's repeated-help removal. Existing queue recovery, inspection-prompt
scoping, and completion-audio work are not attributed to this review.

## Continuing intelligently: current guarantees and the next step

The runtime already does several things well:

- Simple validated commands can bypass executor reasoning. Successful operator
  finishes can bypass a final summarization call.
- Scheduler waits use application state/listeners; submitted work remains tracked
  after the conversational reply. There is no need for model polling to keep it
  alive.
- Generation, native conversation, action/turn identity, and child activity fence
  result attribution. A written prompt, an ended turn, and a successful task remain
  distinct. Uncertain writes cannot be blindly replayed.
- Planned result dependencies and `afterResults` can launch authorized follow-up
  work. Clarification continuations preserve consumed interaction history.
- Input context is bounded; source history remains local, with progressive reads,
  revision-bound cursors, and explicit truncation.

However, result reporting is not general goal evaluation. The result-summary
path reports what happened; it does not normally judge acceptance criteria,
identify missing work, and construct another authorized execution cycle. The
optional background monitor also summarizes rather than plans. Longer tool loops
alone would not supply that missing behavior.

Recommended next work, in order:

1. **Add event-driven goal evaluation for explicitly delegated goals.** Persist the
   objective, constraints, success evidence, ownership, remaining work, and current
   blocker. On an attributed result or blocker transition, evaluate `complete`,
   `continue`, or `blocked`. A continuation must derive from the original objective
   and allowed targets/actions; transcript suggestions cannot mint authority.
   Completion must cite observed checks or clearly state what was not verified.
   Test partial implementations, failed checks, delegated choices, late results,
   changed conversations, cancellation, and uncertain delivery.

2. **Make budgets depend on progress, with a bounded total.** Preserve hard cost
   and cancellation limits. Track changed evidence, resolved grants, distinct
   control attempts, and blocker transitions. Repeated identical failures should
   trigger diagnosis or a concrete blocker; meaningful progress can justify a new
   bounded execution cycle under the same goal. Retain the new separation between
   zero-model finalization and another model/tool round.

3. **Reduce optional monitor calls using meaningful state changes.** Its current
   fingerprint includes `lastActivityAt` and `lastTool`, so routine activity can
   trigger a paid summary that returns `NO_CHANGE`. Measure a local content/state
   fingerprint plus debounce/coalescing, preserving immediate questions, failures,
   and completion reports. This review did not change monitor behavior.

4. **Measure model decisions before adding more tools.** Use held-out requests
   covering direct sends, two-target operations, live inspection, history search,
   busy targets, clarifications, multi-action completion, and failed results.
   Record model calls by stage, input/output usage, redundant reads, tool-validation
   retries, time to first effect, completion evidence, and user clarifications.
   Compare models/prompts on task success as well as cost. Diagnostics already
   identify model calls, stages, and timing; stable token/retry/outcome metrics
   would make this evaluation more useful.

Sources: [task scheduler](../backend/orchestratorTasks.cjs),
[result summaries](../backend/orchestratorResultReports.cjs),
[fast paths](../backend/orchestratorFastPath.cjs),
[context budget](../backend/orchestratorBudget.cjs), and
[diagnostics](../backend/orchestratorDiagnostics.cjs).

## Verification

The parent ran the complete `npm run test:orchestrator` suite: 1,621 tests passed.
Targeted coverage includes scoped tool documentation and limits, real assembled
prompt budgets, directory pagination, provider guidance on reads, partial-command
continuation, tool-result pairing, batched submission and verification, and
uncertain-write non-replay. Routing batching and final-round completion are
separately covered. Backend, shared, and backend-test source hashes remained
unchanged throughout that final verification run.

The offline benchmark passed against a source snapshot and the current working
tree. Local evidence is under `.tmp/orchestrator-efficiency-20260908/`; the
benchmark JSON path is recorded in `latency-benchmark.log`.

No live provider, installed app update, physical voice path, or native terminal
interaction was exercised for this review. These are source changes with
deterministic integration evidence, not a measured live-model quality result.
