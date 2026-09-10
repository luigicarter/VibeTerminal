# Orchestrator repair and code-cleanup plan

This plan covers the [capability audit](orchestrator-capability-audit-2026-09-10.md),
the separate [performance/memory investigation](performance-memory-audit-2026-09-10.md)
and its [implemented follow-up](performance-orchestrator-overhaul-2026-09-10.md).
The original investigation's statement that no application fixes were applied
describes that investigation, before the subsequent source repairs.

**Status:** the cleanup listed under work package 0 is implemented. Packages 1–8
are planned work, not claims of completed fixes. Existing source repairs remain
in the checkout. The installed 0.1.113 app has not been changed.

## Reconciliation of all findings

| Finding | Current source status | Remaining work |
| --- | --- | --- |
| Closed PTYs retained buffers through stop-registry references | Reproduced leak fixed. Eight-pane test: zero retained PTYs, 64 KiB additional live buffers instead of 77.7 MiB. | Keep retirement/unknown-stop regressions; validate packaged close/restart cycles. |
| Observation took about 28 seconds for 2,000 chunks in Electron | Batching fixed; later isolated Electron result was about 39 ms. | **Partial:** hard end-to-end queued-byte limits and consumed-byte feedback remain; package 5. |
| Every output update copied inventories and whole histories | Targeted lookups and separate activity publication implemented. Twenty output updates now send zero unchanged histories. | Keep native-output/history regressions; package 8. |
| Closed runtime records and manual-close decoders retained state | Reproduced paths fixed: compact launch fences, decoder retirement, renderer cleanup and stale-event rejection. | Centralize remaining lifecycle contracts without discarding unresolved stop evidence; packages 2/4. |
| Incomplete escape/control strings grow without limit | Oversized OSC/DCS-style replay is bounded and marked degraded. | **Partial:** general CSI/ESC suffix handling and aggregate transport limits remain; package 5. |
| Fusion/Open Fusion live transcripts and DOM grow indefinitely | Open. | Durable paging, virtualized rows and host byte budgets; package 6. |
| Duplicated 5,000-row scrollback raises normal RAM use | Expected bounded allocation, separate from the leak. | Aggregate budget and inactive-history storage while preserving access to readable history; package 6. |
| All-project Git polling and synchronous untracked scans | Open. | Cached results, backoff, bounded concurrency and work off main; package 7. |
| Completed-build registry/history grows and rewrites synchronously | Open. | Archive policy, active-record indexing and asynchronous persistence; package 7. |
| Main kills helpers immediately after requesting shutdown | Open; source race, no user-process orphaning demonstrated here. | Coordinated shutdown and owned-tree fallback; package 4. |
| Model invents features and error causes | Reproduced in live probes, including after stronger wording. | Application-owned factual answers and error evidence; package 1. |
| Child approval disappears when native tool ID is missing | Reproduced; unresolved. | Scoped approval ledger and trustworthy native correlation; package 2. |
| Inactive-only close rejects otherwise idle structured chats | Restricted coverage; draft/process proof is incomplete. | Structured draft/readiness authority and shared lifecycle preflight; package 2. |
| Close-specific semantic protection does not cover every lifecycle operation | Open architectural gap. | One reviewed lifecycle policy across close/restart/interrupt/project removal/native exit; package 2. |
| Chat lacks request cancel/retry and Orchestrator settings mutation | Capability gaps. | Reuse existing controllers behind scoped new grants; package 3. |
| Late reads could be attributed to a changed conversation | Fixed in source, with identity checks after awaiting the adapter. | Keep replacement/removal/adapter-mismatch and valid-metadata-change regressions. |
| Workspace counts missed background activity and current questions | Fixed in source. | Maintain status parity and interaction-generation checks. |
| Model lacked configuration/capability discovery | Allowlisted read-only facts implemented. | Render supported factual replies from those facts; package 1. |
| Readiness used an obsolete planning schema | Fixed during this cleanup. | Keep readiness and production on the shared planning-envelope builder. |
| Scripted passes were mistaken for factual model acceptance | Live fixtures now identify their limited assertion scope. | Add factual assertions and held-out model/native acceptance; packages 1/8. |
| Older error causes disappear when high-volume timing records rotate shared logs | Confirmed by the historical cross-check: saved errors extend to September 7, detailed retained logs only to September 10. | Preserve bounded request-linked failure facts separately from performance/voice samples; package 1. |
| Native CLI differences, ConPTY recipient limits and hidden compositor timing | Environmental/protocol limits, not dead code. | Explicit coverage, current native fixtures and separate foreground motion checks; package 8. |

## Implementation order

Deliver each package as a reviewable change with its own tests and migration
boundary. Complete packages 1 and 2 before expanding conversational effects in
package 3. Package 4 must precede relying on shutdown to flush new history stores.
Implement package 5's transport contract before package 6's aggregate history
budget. Remove replaced code as ownership moves, not in one blanket deletion.

### 0. Preserve the baseline and remove verified stale code — implemented

**Changes made now:**

- Extracted `createPlanningInput` from `orchestratorInterpreter.cjs` and used it
  for both production interpretation and `orchestrator.cjs` model readiness.
  The previous preflight sized the old `INTENT_TOOL` envelope, not the modern
  `plan_*` tools. A probe measured 22,331 bytes for the old check versus 20,667
  for the current minimal production request. At sampled context sizes 23,552,
  24,064 and 24,576, the old check refused a minimum planner that actually fit.
  Full user requests still undergo their own context checks; this is not a
  guarantee that every request fits one of those models.
- Removed obsolete readiness imports, unused `INTENT_TOOL` from the interpreter
  and unused `WORKSPACE_VIEWS` from the legacy policy module.
- Removed the unused `commandContext` argument from task-assignment preparation.
- Removed the ignored `authoritative` argument from the private terminal binding
  helper. Its real title override is now an explicit `{ liveTitle: true }` option;
  conversation ownership, ambiguity and title-ranking behavior are preserved.

An AST/symbol scan plus call-site review found no other unused top-level imports,
variables or functions in the audited Orchestrator/terminal modules after cleanup.
That is a scoped static result, not a proof that the entire repository contains
no dead code. Four readiness regressions and existing interpretation/runtime
tests exercise the cleanup; the focused run passed 57 tests.

The full `npm run check:orchestrator` run also passed: **2,010 backend tests**,
29 performance regressions, production build, frontend/voice/telemetry checks,
and isolated Electron navigation/task/session-resume acceptance. No paid model
turns or installed-app changes were needed for this cleanup. The existing Vite
large-bundle advisory remains.

**Deliberately retained:** legacy pending-grant decoders, persisted-history readers,
generation/launch fences, uncertain-write receipts and stop tombstones. Also kept
destructuring that deliberately excludes fields from a rest object: for example
`error/reason`, stale binding IDs, provisional creation fields and `reasoning`.
Those declarations can look unused to a scanner while performing real filtering.

### 1. Make capability and error answers factual — P1

**Owners:** `orchestratorWorkspace.cjs`, `orchestratorPlannerTools.cjs`,
`orchestratorInterpreter.cjs`, `orchestratorReplyContext.cjs`,
`orchestratorRequestState.cjs`, `orchestratorConversationStore.cjs`,
`orchestratorFinalResponse.cjs`; proposed small fact/error projection module.

1. Define versioned application facts for implemented capabilities, supported
   settings, unavailable features and configuration values. Facts have stable IDs
   and a source/state revision, with no keys, device IDs or private diagnostic logs.
2. Let semantic planning select a bounded answer type and fact IDs for product,
   configuration and recorded-error questions. The application renders those
   facts, including “not implemented” and “cause unknown.” Do not let another
   unrestricted model paragraph reintroduce unsupported causes or settings.
3. Record safe error categories at the point of failure: request ID, stage,
   supported reason code and whether a cause is known. Bind a question about an
   error to its actual request/reply context, not the most recent global error.
   Old saved errors without typed evidence remain unknown; do not rewrite history
   to give them an invented cause.
   Retain these low-volume failure facts separately from high-rate timing samples
   so performance telemetry cannot quickly rotate away the actionable error trail.
4. Keep general conversation and code explanations available, while separating
   them from app-owned factual claims. Keep the fixed prompt small; do not solve
   this by adding a review call or a large facts dump to every utterance.

**Done when:** a model response attempting to invent an always-listen setting,
security rationale or microphone cause cannot reach text or speech as a supported
fact. Tests include misleading prior assistant replies, generic old errors,
multiple recent failures, topic changes and settings changes during a reply.
Live QA scores factual correctness separately from valid planning and zero effects.

### 2. Repair approval identity and unify lifecycle authority — P1/P2

**Owners:** `agentTelemetry.cjs`, `terminalRuntime.cjs`, `claudeTaskTelemetry.cjs`,
`orchestratorCloseSafety.cjs`, `orchestratorIntent.cjs`,
`orchestratorWorkspaceExecutor.cjs`, `orchestratorIntegration.cjs`,
`observedStop.cjs`, `main.cjs`, chat hosts, chat panes and close/project controllers.

**Child approvals:** maintain pending approval identities per child/tool attempt,
not one unqualified waiting flag. Use native IDs whenever present. Missing IDs may
be correlated with earlier native tool evidence only when the child, generation,
attempt and event ordering establish one candidate. Tool name alone is insufficient.
An unrelated tool return cannot clear an approval. Multiple simultaneous approvals
remain pending until each has a matching resolution. Ambiguity stays explicit and
has a reconciliation path instead of silently clearing or waiting forever.

Test the actual generated Node and PowerShell hook payload shapes through the
authenticated callback path. Cover absent IDs, two same-name tools, duplicate and
out-of-order hooks, child/root replacement, cancellation and child termination.
Resolving an approval must not accidentally settle remaining background work.

**Structured chat inactivity:** introduce generation-bound composer state with
revision, dirty/pending flags and ownership. Keep draft text out of model metadata.
Store/report draft state through an owner that survives pane unmount; absence of a
renderer is not evidence of an empty draft. Combine this with actual host readiness,
pending interactions and detached tasks. Reserve/fence the composer during closure
so an edit cannot land between the eligibility check and the effect. Preserve the
draft and release the reservation on a failed close.

**Lifecycle policy:** use one application-owned policy object for close, restart,
interrupt, project removal and equivalent native exit controls. Preserve reviewed
conditions, exact targets/counts and the original user authority through retries.
Validate the whole selection before sibling effects, then recheck the relevant
activity/input revision at each actual mutation boundary. An alternative operation
must not bypass an inactivity condition. Retain partial receipts and never replay
an uncertain kill, submission or removal.

**Done when:** native/structured parity fixtures reject busy work, new typing,
background children, pending approvals and replaced generations; verified idle
structured panes can close; explicit unconditional operations keep their intended
scope. Include project removal with a mix of pane kinds and mid-operation changes.

### 3. Add the missing conversational controls — P2

**Owners:** `orchestratorPlannerTools.cjs`, `orchestratorIntent.cjs`,
`orchestratorTasks.cjs`, `orchestratorContinuation.cjs`,
`orchestratorWorkspaceExecutor.cjs`, `orchestratorSettings.cjs`,
`orchestratorIntegration.cjs`, `voiceController.cjs`, existing UI controllers.

- Add paged request discovery, request cancellation and retry/resume operations.
  Bind request IDs separately from terminal IDs, with exact group scope where
  needed. Use the same scheduler/continuation service as the UI, not a second
  implementation. Cancel queued unsent work; retain uncertainty for in-flight
  delivery. Already delivered work cannot be unsent. Stopping its agent needs a
  separate authorized lifecycle operation. Retries must inherit constraints and
  may execute only remaining, proven-unconsumed work.
- Add an allowlisted settings-change grant for existing supported settings.
  Validate the exact requested field/value through the current settings service,
  including model catalog membership and voice capture/restart requirements.
  Do not expose credentials or arbitrary configuration patches. Raising/removing
  a spending limit requires that actual user instruction.
- Do not implement an always-listen mode merely to make an invented setting real.
  Package 1 must report its absence. A new voice product mode would need its own
  capture, interruption, consent and hardware acceptance design.

**Done when:** mixed queued/running/finished/restored requests behave predictably;
follow-up wording resolves the correct request; retries cannot duplicate work;
concurrent settings changes cannot race microphone capture, speech or validation.
Capability facts and UI controls reflect exactly the newly supported operations.

### 4. Coordinate shutdown and helper ownership — P2

**Owners:** `main.cjs`, `observedStop.cjs`, `ptyHost.cjs`, `fusionChatHost.cjs`,
`openFusionChatHost.cjs`, launch preparation, voice and persistence owners.

Create one idempotent shutdown barrier: stop new admission, settle/cancel pending
preparation, request helper cleanup, await acknowledgement/exit and flush app-owned
state. Replace immediate helper kills with a bounded fallback using retained
process-tree ownership. Do not signal a recycled PID or report tree termination
from a write acknowledgement. Keep intentional detached builds distinct from
processes that shutdown owns. Report unresolved cleanup honestly.

**Done when:** ordinary exit, updater exit, helper crash and timeout fixtures cover
PTYs, both chat hosts, voice helpers and pending launches in a disposable Windows
profile. Repeated shutdown is harmless; all expected owned descendants terminate;
intentional detached work and user files survive. Other platforms retain truthful
proof limits rather than borrowing Windows guarantees.

### 5. Complete output flow control and parser bounds — P1/P2

**Owners:** `ptyHost.cjs`, `terminalHistory.cjs`, `terminalObservation.cjs`,
`main.cjs`, `preload/preload.cjs`, `frontend/components/TerminalPane.tsx`.

Track queued bytes through PTY history, stdout, main observation, snapshots and
renderer parsing. Use per-pane and aggregate high/low watermarks, with consumption
acknowledgements bound to generation and output sequence. Track actual renderer
attachment separately: an unmounted pane must not stall while waiting for a
nonexistent renderer. Bound/coalesce redundant snapshot requests and define how
an interrupted attachment resumes from a valid snapshot boundary.

Extend incomplete control handling to general CSI/ESC sequences with explicit
parser state and degraded-replay metadata. Never arbitrarily slice ANSI bytes,
turn discarded control payload into visible input, or claim a clipped replay is
complete. Preserve split Unicode, resize/read barriers and input acknowledgements.

**Done when:** simultaneous visible/hidden floods, rapid mounts, stalled consumers,
large snapshots and malformed sequences show bounded application queues and
responsive control handling. Test sequence continuity and parser parity; retain
the improved decoding measurements without timing-fragile CI assertions.

### 6. Bound long-lived chat and scrollback memory — P2

**Owners:** both chat hosts, `FusionChatPane.tsx`, `OpenFusionChatPane.tsx`,
`ocChat.tsx`, history readers/stores, `terminalHistory.cjs`, `TerminalPane.tsx`.

First provide durable access to older transcript/events and large tool outputs,
with opaque page references and bounded previews. Then use host byte budgets and
a deque/ring structure, stable tool/stream indexes, and virtualized renderer rows.
Keep a bounded live working set while older content remains pageable. Preserve
concurrent stream identity, task/permission rows, replay ordering and scroll anchors.

Introduce an explicit aggregate terminal-history budget and an app-owned inactive
history store. Preserve the readable-history behavior repaired in 0.1.113; lowering
the 5,000-row limit everywhere is not the leak fix. Define recovery after a failed
spill, corrupted page or low disk space. Keep Open Fusion storage isolated from
the user's global OpenCode home.

**Done when:** long sessions, very large tool outputs, multiple open chats and wide
terminal panes have bounded live memory/DOM growth; old content remains accessible;
remount/resume preserves identity and scroll position. Measure live heap/buffers
separately from allocator RSS and loaded voice/GPU memory.

### 7. Reduce polling cost and consolidate old ownership paths — P2/P3

**Owners:** `codeChanges.cjs`, `workspaceChanges.cjs`, `buildSupervisor.cjs`,
`frontend/App.tsx`, Orchestrator schema/policy/continuation modules and test fixtures.

- Move bounded untracked-file scans off the main thread, limit concurrent Git
  scans, cache unchanged summaries and back off inactive projects. Refresh on
  user demand/focus and meaningful lifecycle changes; preserve observation age
  rather than representing a cached result as freshly read.
- Index active builds separately from archived settled history. Archive/prune
  only unreferenced settled metadata under an explicit retention policy while
  keeping log access and all active/unresolved ownership. Make persistence
  asynchronous, atomic and flushable through package 4.
- Separate modern semantic planning from compatibility decoding. Modern prompts
  should not carry contradictory legacy payload instructions. Use one owner for
  normalization, authorization, dispatch and result formatting at each boundary.
  Migrate deterministic test stand-ins to the current protocol while retaining
  explicit legacy-resume tests. Only then remove unreachable aliases/helpers.
- Before deleting an exported module or branch, check backend, renderer, preload,
  generated hooks, dynamic loaders and scripts. Record its replacement and stored
  data migration. Never delete launch tombstones or uncertain receipts just because
  they are old, or remove destructuring that intentionally strips authority fields.

**Done when:** unchanged projects/build registries do not churn React or disk;
freshness is explicit; legacy pending work still resumes safely; every advertised
tool has a current schema, guide, authorization path and executable owner.

### 8. Validate each slice and release a reviewable candidate

Retain `npm run check:orchestrator` and focused tests for each package. Add a
held-out matrix of ordinary wording, typos, follow-ups, conflicting history,
multiple projects, simultaneous questions and mid-operation identity changes.
Score interpretation, authorization, factual answers, delivery, native completion
and UI state separately. Require no unsupported app facts or out-of-scope effects
in the defined acceptance set; publish sample sizes and failures instead of
claiming a universal reliability rate.

Run capped model probes against synthetic adapters, then disposable real native
provider fixtures for the changed contracts. Test cold start, restart, hidden-pane
remount, manual close, project removal, settings changes and shutdown. Keep
foreground compositor and physical microphone acceptance separate from hidden
functional fixtures; do not weaken frame assertions to obtain a pass.

Package on Windows, verify source/ASAR parity and the installer/update artifacts,
and run the packaged smoke/retirement/soak checks for that slice. Keep immutable
release history and source/package/installed boundaries clear. No release or
installation is performed by writing this plan.

## Evidence retained for the cleanup

- `.tmp/orchestrator-unused-before.jsonl` and `orchestrator-unused-after.jsonl` — scoped top-level symbol audit.
- `.tmp/orchestrator-unused-nested-after.jsonl` — intentionally retained filtering/compatibility declarations.
- `.tmp/orchestrator-readiness-before.json` — obsolete/current minimum-envelope comparison.
- `scripts/backend/orchestrator-model-readiness.test.cjs` — current-envelope parity and readiness boundaries.
- `.tmp/orchestrator-cleanup-focused.log` — 57 focused tests passed.
- `.tmp/orchestrator-plan-cleanup-acceptance.log` — full cleanup acceptance run.

The next implementation work is package 1 (factual answers/error evidence) and
package 2 (approval/lifecycle identity). Memory and capability expansions follow
their dependency boundaries above; the plan does not label them fixed today.
