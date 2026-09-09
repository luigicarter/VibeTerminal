# Orchestrator recovery and close-all fix plan

Planning investigation: September 9, 2026. Baseline source: `aac91eb2cf02ebe4bd58bcfa748a5817a5bdd569`, version `0.1.104`. This document records the original implementation plan. Source and packaged fixes are now verified; see [implementation and acceptance](orchestrator-recovery-review.md) for the completed work and installed-build boundary.

The fixes should make three decisions application-owned: which panes constitute a requested group, whether an effect actually completed, and which request owns unfinished work. The model still interprets intent and resolves meaningful ambiguity. Its selected ID list, success prose, and dependency declaration must each pass the corresponding application checks.

## 1. Evidence and limits

The installed `app.asar` and source versions of the main Orchestrator, intent, route planner, task scheduler, conversation store, integration, and command-completion modules were compared. They match after newline normalization. The main-process stop handlers, PTY/Fusion/Open Fusion hosts, and terminal runtime were also compared and match. The reported behavior belongs to the installed build, not merely a different development checkout.

The saved conversation and rotating private diagnostics establish this sequence, in Toronto local time:

| Exchange | Observed result | Confidence and boundary |
| --- | --- | --- |
| September 9, about 05:25: close all project terminals | Four selected task targets and four `close_requested` receipts; assistant announced all terminals closed; no follow-up inventory tool call in the exchange | Confirmed. The user reported that approximately half remained. The exact original complete pane inventory was not retained in the inspected log. |
| About 08:02: open a new Codex terminal to investigate | Eight assignment-model rounds, then routing discovery exhaustion; zero assigned task targets and no action receipts | Confirmed. Individual routing reads and validation errors were not logged, so the precise sequence of discovery decisions is unknown. |
| About 08:03: action the last request | Dependency on the failed investigation; prior request changed to `finished` while retaining its routing error; successor failed because no verified result existed | Confirmed. The status mutation is reproducible in the installed-equivalent code. |

Evidence sources are `%APPDATA%/vibe-terminal/orchestrator-conversation.json` and `logs/orchestrator-errors.jsonl` plus its rotated files. Keep those private; regression fixtures should use synthetic identities and objectives.

Two historical details must remain explicitly unresolved:

- Dormant panes are present in the directory and can be closed. A synthetic fixture with four active and four dormant panes exposes all eight. Normalization accepts either a four-ID subset or all eight for `selection: all`. Thus incomplete coverage is a demonstrated defect, but the exact reason the live interpretation selected four is not established.
- Speech transcription included an ambiguous phrase resembling “and a web terminal.” Planning must test both “in vibeTerminal” and an actual two-terminal request. Do not silently decide that the recorded wording proves either interpretation or that transcription changes are required.

## 2. Required behavior and invariants

1. A project-wide close targets the complete, application-resolved membership of that project at admission, including dormant panes. An explicit list still means exactly that list.
2. Scope is frozen. New panes created after admission are preserved; restarted replacements are never closed using an old identity.
3. A close acknowledgment is distinct from committed pane removal and observed process termination. Text, voice, task status, and the completion cue derive from the same effect evidence.
4. A fully specified new Codex task reaches the existing creation/submission machinery without conversation-discovery model calls.
5. A continuation transfers only unfinished command authority. It does not manufacture a completed result, replay delivered siblings, or overwrite the result ownership of an existing native turn.
6. A result dependency still requires an attributable result from its actual producer. Failed, historical-only, ambiguous, or empty-wait records cannot supply one.
7. Every recoverable unfinished objective has one current owner. Before an ownership transfer fails, the original remains intact; after a committed transfer fails, the successor owns recovery.
8. Existing cancellation, generation fencing, provider isolation, workspace occupancy, and uncertain-delivery protections remain effective.

## 3. Fix group A: complete scope and verified closure

### A1. Compile group scope instead of trusting enumeration

The current target compiler in `backend/orchestratorIntent.cjs:280` validates only the IDs supplied by the interpreter. `selection: all` does not assert coverage of a project. `orchestratorContext.cjs` carries `projectName` and `cwd`, while the integration directory already retains `projectId`.

Require a close-specific scope selector in the model intent contract, for example:

```json
{ "kind": "close", "scope": { "type": "project", "projectId": "project-1" } }
```

Support a known project, the global board, all workspace panes when explicitly requested, and explicit pane IDs. Keep these scopes distinct. Remove the list-only `selection: all` path from new model-produced close intents; translate trusted UI actions naming exact panes to an explicit-ID scope. The interpreter must represent a project-wide request as a project scope, rather than enumerating its current page. Scope classification remains a semantic model boundary and needs real-model phrase tests; application coverage is guaranteed once the scope is correctly identified. A named split group can be added only if the renderer exposes an authoritative group identity; otherwise resolve “pane” from context or ask a focused question. Do not widen a group close into every pane sharing a directory.

The backend resolves the selector against a complete, current renderer-owned pane snapshot. Use project membership rather than current working directory: a project terminal can `cd` elsewhere, and a global pane can share the project's directory. Carry stable project IDs and board membership through context summaries. Runtime-only orphan processes are excluded from a request to close visible project panes and reported separately when relevant.

Freeze an operation record containing scope, inventory revision, target count, and each pane's ID, launch token, and current runtime generation when available. If the interpreter supplies both a selector and IDs, require equality with the resolved set. A truncated model directory cannot truncate the app-resolved set. Empty scope produces an evidence-based no-op. If a safety bound is exceeded, return a specific unresolved-scope result rather than silently taking the first page.

Keep general target-selection behavior unchanged for unrelated operations. Introduce this contract for close first, with reusable resolution helpers where appropriate.

### A2. Treat pane and process identities separately

Dormant panes currently use a synthetic generation (`orchestratorIntegration.cjs:250`). A close should bind the pane's identity even if no process exists. For a live pane, additionally fence termination against the exact runtime generation.

Revalidate the frozen identity immediately before mutation. An absent original pane can be counted as already absent after fresh observation. A changed launch token or runtime generation is a superseded target: preserve the replacement and report it. An uncertain earlier close permits observation and reconciliation, not an unqualified second mutation.

Extract a shared close operation from `frontend/App.tsx:2832–2867` and the Orchestrator UI handler near `4776`. It should expose committed pane-removal and stop outcomes rather than discarding the stop promise. Keep tile detachment, draft cleanup, focus/maximize updates, launch cancellation, and native/Fusion/Open Fusion handling consistent with normal UI close behavior.

A stop API returning `true` must not automatically mean process exit. This is a confirmed provider-protocol gap: the Fusion/Open Fusion IPC handlers in `backend/main.cjs:2856,3243` return `true` after sending an ID-only request; `fusionChatHost.cjs:1627` and `openFusionChatHost.cjs:2991` emit `closed` before killing/deleting their child state; `terminalRuntime.cjs:627` synthesizes `processState: exited` during stop. The directory also removes chat state while forwarding stop. These values cannot be reused as observed exit proof.

Implement a correlated stop operation through main, preload/type contracts, integration, and the native/Fusion/Open Fusion hosts. Carry the operation ID and frozen pane launch/runtime generation all the way to the host that performs the mutation; the host must validate them against the actual child before killing. Never replace a supplied stale identity with the current generation. Keep an operation registry after live session-map removal, keyed to the original child/process identity, and settle it from actual PTY/child-exit evidence or positively established absence. Host loss, kill rejection, and timeout remain unknown/failed. Synthetic `closed`/`exited` events do not settle it. Include supervised processes owned by that terminal; arbitrary detached external work is outside the termination claim.

Keep existing boolean stop callers compatible: introduce a separate observed-stop result/event rather than changing a boolean to an object that existing truthiness checks would treat as success. Route the shared UI close operation through the common stop machinery. Once the UI disappears, unresolved process evidence must remain observable without a mounted pane. Catch stop errors and preserve their outcome.

Before certifying absence for a dormant/starting pane, confirm cancellation or settlement of that exact pending launch/preparation. A single runtime-absent snapshot is insufficient while a delayed native or chat preparation can still create the old process. Await the relevant `terminalLaunchCoordinator`/main preparation and asynchronous `chatLaunchPreparation.cancel` fence; a replacement launch is a different identity and remains protected.

Suggested evidence shape, internal to the application:

```text
operationId, target identity, scope snapshot revision
pane: present | removed | already-absent | superseded | unknown
process: running | stopped | already-absent | failed | unknown
verification revision/time, bounded failure reason
```

Only committed removal plus confirmed stop/already-absence and settled launch cancellation qualifies as fully closed. Dormant panes need positive current evidence that no matching runtime exists or can still emerge from pending preparation. A removal with an unresolved stop is partial completion.

### A3. Verify fresh state and publish factual outcomes

Use the existing inventory invalidation mechanism in `orchestratorInventory.cjs` so a read begun before the close cannot certify it. The renderer must acknowledge state commitment through a commit observer or an appropriate existing `flushSync` pattern. Backend verification then reads the post-mutation pane and process state with bounded waiting and cancellation. Do not treat `observations.forget` as proof of termination; postpone evidence cleanup until reconciliation is complete.

Extend `orchestratorFinalResponse.cjs`, `orchestratorResponse.cjs`, `orchestratorCommandCompletion.cjs`, and the finalization gate in `orchestrator.cjs:1471–1541`. Currently the evidence formatter is invoked for submission/creation outcomes but not close-only requests. `close_requested` already fails the completion-cue predicate, yet free-form success prose can still be published.

For lifecycle effects, use application-generated factual responses for pending, failed, superseded, and partial results. Do not inspect model wording for success keywords. Use the frozen denominator and verified outcomes; full receipts keep per-target detail. The same result must control `ok`, durable status, display text, speech text, and the cue.

Examples:

- Four of eight complete: “Closed 4 of 8 terminals. The other four are still open.”
- Pane removed, process unresolved: “Removed the pane; its process stop is still unconfirmed.”
- Eight original panes closed, one opened meanwhile: “Closed the eight original terminals; one new terminal remains.”
- All required effects confirmed and no exceptional remaining-state explanation: retain the existing `done` response and voice cue.

The new-pane example is a successful snapshot operation, but its explanatory text must not be replaced with an unqualified `done`. Separate successful effect accounting from eligibility for the short completion presentation. Claim an empty project only when the latest complete inventory supports that stronger statement.

## 4. Fix group B: direct new-worker assignment and bounded discovery

### B1. Bypass conversation discovery for a bound new worker

In `prepareTaskAssignments` (`orchestrator.cjs:566–606`), existing verified owners can bypass the route model. Explicit-new currently reaches the model and is enforced only after it chooses. Move the fully determined resource decision into the application.

After existing reservation and uncertain-creation checks, a validated `delegate_task` grant with `assignmentMode: new`, known project, and exact available configured launcher creates a deterministic `create` proposal. It must flow through the existing common proposal validation, work-item/reservation handling, one-use creation claim, native creation receipt checks, identity binding, readiness checks, and operator submission.

Do this per grant. Preserve independent work items, mixed explicit/routed actions, all requested workers, full objective text, literal/composed payload mode, and answer/permission/lifecycle constraints. Creation itself must never send the task as an unverified side effect.

If an explicit requested launcher is unavailable, report that launcher’s actual blocker without provider substitution. If a new task omits the launcher, use an established applicable preference or the sole eligible configured launcher; otherwise perform a bounded launcher choice. That uncertainty does not justify scanning old conversations. If project or provider meaning is unresolved, resolve that specific uncertainty before effects.

A creation already in progress, timed out, or uncertain must retain its reservation and exact pane/launch identity. The deterministic path cannot create a duplicate merely because the request says “new” again.

### B2. Make general discovery account for progress

Keep the existing eight-call routing budget and support for targeted history reads and pagination. A current test legitimately needs seven read rounds to reach candidate 237, then chooses on the eighth. Preserve that case.

Add request-local tracking of normalized operation/parameters and a bounded fingerprint of returned semantic metadata. New candidates, advancing cursors, and meaningfully changed observations count as progress. Exclude read timestamps and revisions that increment merely because a read occurred; otherwise repeated unchanged reads evade the policy. An unchanged repeated read or repeated validation error does not count as progress.

After two consecutive non-progress rounds, supply a concise application-owned correction with the unresolved decision and existing evidence. Reserve the final call for a standalone decision, keeping it within the eight-call total. The final tool exposure can permit only `choose`, with the normal validation afterward. If insufficient evidence remains, the planner must identify that limitation; it may not create or reuse an arbitrary worker to satisfy the budget. Treat the two-round threshold as a testable initial policy and verify that it preserves legitimate refreshed observations and pagination.

Exhaustion returns a typed routing failure for the affected grant, with its original objective retained and an explicit `not-assigned`/`not-dispatched` state only when that grant's evidence supports it. Earlier grants in the same request may already have started creation (`orchestrator.cjs:620`). Preserve those grants' exact receipts, reservations, ownership and partial effects; never stamp the whole request undispatched or create their workers again on retry. Exhaustion must not become completion or cause automatic creation in an unrelated conversation. Preserve cancellation and incomplete-provider-response checks.

## 5. Fix group C: truthful continuation and atomic ownership

### C1. Separate continuation from a result dependency

The immediate status defect is `retireClarification` at `orchestrator.cjs:1251`: clearing `pendingCommand` and inspecting an empty wait list changes a failed request to `finished`. At `1290`, the new request waits for its declared prerequisite; `readDependencyResults` at `1640` correctly rejects the nonexistent result.

Keep the verified-result guard. Strengthen interpretation/normalization to distinguish:

- **Continue/retry:** act on the application-owned remaining objective.
- **After results:** consume an attributable result from earlier submitted work.

Validate this relation before changing either request. A no-dispatch retry cannot depend on a result its source never produced and cannot still produce. Return that contradiction through the existing bounded interpretation-repair path, using the original context. Do not silently delete arbitrary dependencies: an earlier request that submitted real work before asking a clarification can legitimately be both part of continuation lineage and a result producer.

The app’s evidence, not absence of diagnostic lines, determines whether effects occurred. Preserve request-level result semantics; introducing partial per-target result dependencies is outside this repair. Freeze which original operation slots require native results, separately from ancillary control effects, so that native completion of a submitted subset cannot stand in for the whole request.

Use a conservative result-scope rule for this repair: if an unsubmitted slot in the original required-result scope transfers to a successor, the predecessor cannot satisfy a whole-request dependency. A waiting dependent pauses with the continuation link; it neither silently follows descendant request IDs nor aggregates partial results into invented success. Native wait evidence and occupancy still update. An explicit later request can inspect the full continuation or identify its result source. If the predecessor's complete required-result scope was already dispatched and only ancillary control transfers, it remains a valid potential producer subject to all existing attribution checks. This distinction needs its own regression; a blanket ban on all transferred predecessors would break legitimate dependencies.

### C2. Define a concrete state contract

Add historical `continuedFromRequestId` and `continuedByRequestId`, separate from `dependsOn`, and a control disposition (`active`, `needs-answer`, `transferred`, `completed`, `failed`). Introduce terminal scheduling status `continued` for retired unfinished control with no native result to await. Apply these rules at transfer:

| Predecessor evidence | State after transfer |
| --- | --- |
| Failed before assignment/dispatch | Keep `failed` and its original error; mark control transferred and link the successor |
| Clarification/unstarted control with no native waits | `continued`; no pending question and no success cue |
| Native work still pending | Retain `waiting-results`, waits, producer identity, and occupancy; control may be transferred separately; preserve the required-result-scope eligibility flag |
| Failed native result | Retain `failed` and result evidence |
| Attributable completed native result | Preserve per-wait result evidence; publish `finished` only if the original required-result scope is complete and eligible; otherwise keep historical failure or `continued` |

`continued` is terminal for scheduling/retention but never successful for dependency admission. Explicitly reject a dependency on a retired nonproducer instead of waiting forever. A later real native result updates per-wait evidence without undoing transferred control or the required-result-scope barrier. Wait reconciliation and resource occupancy must operate even when the request's display status is `continued` or `failed`; do not leave this logic conditional solely on `waiting-results`.

Audit `orchestratorTasks.cjs` status sets, reconciliation, finalization, cancellation, dependency admission and retention; `orchestratorConversationStore.cjs` whitelists/restoration; `frontend/orchestratorUi.ts`; `OrchestratorPanel.tsx` badges and Cancel/Stop-all affordances; work-history and result-report projections. Control-only continuation must not mark the shared work item successful while its successor is active.

### C3. Commit transfer before effects, without losing recovery

Extract a focused continuation helper and a scheduler batch-update operation:

1. Resolve the current owner through bounded original-source lineage; capture its pending-command identity/revision.
2. Validate the successor’s unchanged original objective, remaining operation slots, target identities, creation reservations, dependency semantics, and queued-transfer eligibility. Perform no ownership mutation here.
3. Immediately before commit, under routing serialization, recheck ownership/revision and actual action consumption. Concurrent answers/retries can have only one winner.
4. In one synchronous commit, install successor ownership, associate reservations, set historical links, and retire only the predecessor’s transferred control. Notify state consumers once. Preserve native waits on their producer.
5. Only after that commit may assignment creation or input effects begin.

A precommit failure leaves the predecessor intact. A postcommit failure retains the original lineage and unfinished objective on the successor. Do not restore predecessor authority after a possibly effectful operation. Subsequent retries resolve the current owner, including after several clarification hops.

Reuse the strict bounds of `captureQueuedCommand`/`assertQueuedTransfer` in `orchestratorQueuedRecovery.cjs`. Scheduler admission queues are different from delivery queues, admitted work, partially executed operators, and unknown writes. Preserve all original selectors, access constraints, real prerequisites, deferred clauses, and operation history.

For partial multi-target work, keep submitted siblings’ waits and result identities on their original request; transfer only eligible remaining slots. Uncertain steps remain blocked against replay. A created-but-unbound worker retains its creation receipt and reservation; recover that same worker. Cancellation never releases occupancy from already delivered or background work merely because control moved.

### C4. Preserve history without reviving authority

Persist only bounded optional historical linkage/disposition fields. Continue excluding grants, execution permissions, live reservations, and replayable operation state. Restored unfinished work stays paused pending fresh identity/effect evidence; no automatic replay after restart.

Old records receive conservative display defaults. Do not infer success from an old `finished` record with an error or no result, rewrite historical transcripts, or mint retry authority from assistant prose. A crash between an external effect and asynchronous persistence remains an uncertainty boundary. Crash-safe exactly-once execution would require a separate durable effect journal and is not promised here.

## 6. Diagnostics and user-facing failures

Add operational evidence while implementing the paths, through explicit sanitizer fields in `orchestratorDiagnostics.cjs`:

- Close: scope kind/opaque ID, snapshot revision, selected/verified/remaining/superseded counts, operation and target identity, verification outcome.
- Routing: grant correlation, strategy (`explicit-new`, verified owner, discovery), round, operation kind, bounded error category, counts, pagination/progress flags, final decision or exhaustion.
- Continuation: source/current/successor IDs, captured revision, transfer stage, prior/new status and control disposition, dependency-validation category, original failure stage.

Use bounded fields and redaction. Exclude task text, output, query strings, transcripts, and reasoning content. Keep fingerprints request-local when practical. Terminal diagnosis should remain available even if high-volume voice inference causes log rotation; add tests for bounds/rotation and avoid one diagnostic event per wait tick.

Map typed failures into useful text and voice. “I couldn't assign a terminal; the investigation hasn't started” should replace an internal routing-limit exception. A recoverable retry should use the preserved objective. An unresolved prerequisite should describe the actual missing result and known producer; it should not tell the user to inspect a terminal that was never created. Do not add routine permission questions.

## 7. Implementation order and ownership

| Work package | Scope and likely files | Exit criterion |
| --- | --- | --- |
| 1. Regression fixtures and evidence contract | Existing backend suites; synthetic close/continuation fixtures; diagnostics and shared effect-evidence helpers | Exact defects reproduced, with assertions for the intended behavior ready to turn green; known-result safeguards remain represented |
| 2. Truthful close publication | `orchestratorFinalResponse.cjs`, `orchestratorResponse.cjs`, `orchestratorCommandCompletion.cjs`, finalization in `orchestrator.cjs` | Close acknowledgments can no longer produce unsupported success in text, voice, return status, or cue, even before full closure support lands |
| 3. Continuation ownership | New continuation helper; intent/tasks/queued recovery/store/UI; main integration | Failure stays truthful, one current owner, real dependencies preserved, exact natural and UI retries recover safely |
| 4. New-worker assignment and discovery | `orchestratorRoutePlanner.cjs`, routing helpers, main assignment integration, diagnostics | Bound-new uses zero route-model calls; creation remains single-use and verified; auto pagination and uncertainty handling pass |
| 5. Complete close scope and lifecycle verification | Intent/context/integration/inventory; extracted renderer close operation; main/preload/types; PTY/Fusion/Open Fusion hosts and runtime; pending launch preparation | All original project panes are accounted for with committed removal, true process-exit evidence, settled launch cancellation, and accurate partial reporting |
| 6. Combined acceptance, docs and release preparation | Backend/frontend/Electron suites; product docs; packaged acceptance | Complete conversation succeeds against disposable panes; source, package, and installed verification boundaries are explicit |

One integrator owns edits to `backend/orchestrator.cjs` and the shared finalization/schema integration. Helpers, provider-specific evidence, renderer close implementation, and tests can be delegated with separate file ownership. Avoid parallel edits to the central orchestration file. Package 5 can be developed alongside 3/4 once its contract is agreed; do not publish an incomplete behavior claim.

The deterministic new-worker change is relatively contained. Continuation ownership and asynchronous closure verification carry the larger integration risk because they cross scheduling, provider lifecycle, persistence, and UI state.

## 8. Acceptance matrix and release boundary

| Test family | Must prove |
| --- | --- |
| Group coverage | Four active + four dormant panes in one project all included; project-scope supplied IDs omitting members rejected; explicit-ID subset accepted exactly; more than one directory page supported; empty scope is factual |
| Membership | Same-cwd global pane excluded from project close; project pane with changed cwd included; ambiguous project/group does not broaden scope |
| Lifecycle races | New pane preserved; restarted replacement fenced; delayed stale stop reaches each host without killing replacement; already-absent target observed; delayed React commit and pre-mutation inventory cannot certify success |
| Pending launches | Close during pending native/Fusion/Open Fusion preparation, then resolve delayed preparation: no old matching process can appear after verified closure |
| Process outcomes | Native, Fusion and Open Fusion stops checked; synthesized closed/exited and boolean acknowledgments do not prove exit; false/rejected/timeout/late stop outcomes remain visible; removed pane with live process stays partial |
| Publication | Model says “all closed” with request-only receipts; mixed successful/failed effects; no blanket success, false `ok`, cue, or contradictory voice; complete evidence permits expected acknowledgment |
| Bound-new | Many existing/busy panes; zero route-model calls; one creation and one verified submission; exact project/provider/objective/constraints retained |
| Multiple tasks | Two new workers and mixed direct/routed grants preserve every clause, independent identities, and mutation scheduling; grant A creation in flight/complete followed by grant B discovery exhaustion preserves A and retries only unfinished work; ambiguous transcription gets contextual resolution |
| Discovery | Repeated unchanged reads, including timestamp-only changes, and validation errors converge; changed observations and advancing pagination still work; legitimate seven-read/eighth-choice fixture retained; exhaustion reports accurate per-grant assignment/effect state |
| Retry state | Exact failed route → natural retry with impossible same-source dependency repaired before mutation; explicit UI retry works; neither manufactures finished work |
| Transfer failures | Precommit failure leaves owner intact; postcommit failure leaves one successor owner; concurrent retries have one winner; multiple clarification hops retain original authority |
| Replay prevention | Partial multi-target delivery never resends successful siblings; delivery queue/unknown write inspected; timed-out creation recovered by exact pane rather than duplicated |
| Result dependencies | Genuine review→fix success works; failed/cancelled/ambiguous/restored/no-result producers remain gated; submitted A plus transferred required B cannot satisfy the original whole-result dependency when A ends; complete original producer plus ancillary-control continuation still qualifies; `continued` nonproducer fails rather than hanging |
| Persistence and retention | History clear/capacity eviction retains live lineage and native waits; restart restores history without executable grants; cancellation preserves live occupancy |
| UI and voice | Continued/failed badges and retry links are truthful; transferred control gets no done cue; text and transcribed voice use identical behavior; errors are actionable |
| Diagnostics | Sufficient typed metadata to distinguish underselection, removal failure, non-progress routing, and invalid transfer; bounds/redaction remain effective |

An existing test in `orchestrator-continuation-history-integration.test.cjs:97` explicitly expects a clarified predecessor to become `finished`. Change that expectation deliberately, while preserving the stronger existing guarantees: original operator state survives history clearing/eviction, and multiple continuations produce only one creation/submission. Do not weaken the no-result dependency tests to make the retry pass.

Parent verification during planning:

- 56 focused tests passed across route planner, routing recovery, failed dependencies, correction/queued recovery, final response, command completion, inventory, and conversation store.
- 78 additional tests passed across routing intent, auto-routing integration, multiple work items, continuation history, and blocked recovery. Total: **134 distinct passing tests**, zero failures. They establish the current baseline, not repaired behavior.
- Parent isolated fixtures reproduced incomplete close selection (4 accepted out of 8 available), acceptance of all dormant targets, missing close-only evidence formatting while the cue is blocked, failed→finished predecessor mutation, and eight read-only planner rounds despite explicit-new scope. These use synthetic adapters, not real user terminal effects.
- Independent plan review checked the combined design against the source. Its corrections are incorporated: actual host-exit proof, pending-launch cancellation, whole-request result eligibility after partial transfer, per-grant routing failures, and semantic discovery progress. This is design acceptance, not implementation acceptance.

During implementation, first run affected test families and the real asynchronous renderer/backend close fixture. Then run `npm run check:orchestrator` once for the integrated revision, expanding only for failures or new concerns. Test changes to UI state through behavior, not source-text assertions alone.

Run a combined hidden Electron scenario in a disposable project/profile: create eight mixed active/dormant panes, close the project, verify all original panes/processes, inject a routing failure, issue the natural retry, verify a single new Codex assignment and exactly one prompt delivery, then inspect task history and spoken response events. Add concurrent creation and one failed-stop variants. Use the configured model on disposable adapters to test the actual interpretation phrases; use a disposable native Codex pane to verify the real submission boundary. Mocked model tests cannot certify natural-language interpretation, and synthetic voice events cannot certify microphone/STT capture.

Finally build/package and repeat the combined acceptance against the packaged executable. Release through the documented Windows version/feed/artifact workflow when implementation is approved for release; committing source alone does not update the installed app. Preserve the user's working terminals during QA and use a planned restart when installing. A later installed-build check must verify the version/content and the repaired scenario before claiming the user's running application is fixed.
