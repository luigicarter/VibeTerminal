# Orchestrator de-serialization plan

September 11, 2026. Follow-up to
[the deep dive](orchestrator-deep-dive-2026-09-11.md). That audit concluded the
harness does not need a rewrite: the guarded core works, and this week's
failures were seam defects. It also concluded that the harness is
over-serialized. A single "continue" request makes six model calls over about
34 seconds, four reviewers parse prose as JSON, two harness generations run side
by side, and every incident has added a guard rather than removed a judgment.

**Status (end of September 11):** packages 1 through 8 are implemented in
source and independently audited; package 0 (release) is deferred by user
decision, so the installed 0.1.116 has none of this. Final checks: backend
suite 2,164 pass, `tsc --noEmit` clean, routing probe 1 model call, live-tasks
probe four of four with zero 4xx. Packages are ordered by payoff over risk;
each must remove a model judgment, a duplicated path or a failure class, never
add a reviewer or a fence.

**Rule for every package:** the change must delete or bypass at least one model
call, branch or rejection class, and its done-when must measure that.

## Reconciliation of findings to packages

| Finding (deep dive) | Package |
| --- | --- |
| Fixes exist only in source; installed app is 0.1.116 | 0 |
| "Continue" needs planner, router and affinity reviewer to agree; six calls | 1 |
| Four reviewers parse prose JSON; fence bug existed in four copies | 2 |
| Operator actions rejected because the model forgot the observation protocol; startup confirmed by screen state only | 3 |
| Coordinator branches 28 times on legacy versus agents-v1; 68 of 69 tests run the legacy path | 4 |
| Diagnostics log is 99 percent voice telemetry and rotates daily | 5a |
| Generic "could not interpret" hides the validator reason | 5b |
| Wake prefix survives into instructions on all paths except literal "hey lina" on wake | 5c |
| 48,000-byte input ceiling regardless of the model's window | 5d |
| No standing measurement of call count or latency per request class | 6 |

## Implementation order

### 0. Release what already exists — P0 (deferred by user decision, September 11)

The user chose to keep the Orchestrator repairs in source without publishing
a release for now. The steps below remain the procedure when a release is
wanted; the local gate (build, routing smoke, whitespace check, backend suite)
passed on September 11 before that decision. The release was prepared as
0.1.117 on September 12, 2026; see
[the release review](release-0.1.117-review.md).

**Owners:** the whole working tree; `apps/desktop/package.json`, `README.md`,
`docs/windows-release.md`.

The checkout carries the continuation repairs, today's fence-tolerant reviewer
parsing, and unrelated uncommitted work: Codex Web and Open Codex changes,
removal of the in-app version switcher, and the release workflow's new packaged
Open Codex smoke. Nothing reaches the installed app until a tag builds.

1. Run the release gate locally: `npm run test:orchestrator`, `npm run build`,
   `npm run smoke:frontend:orchestrator-routing`, `git diff --check`.
2. Follow the documented publication steps in `docs/windows-release.md`:
   `npm version patch --no-git-tag-version`, update the release links, commit
   `Release v0.1.117`, tag, push `main` and the tag.
3. After the workflow publishes, update the installed app and confirm
   `orchestrator-errors.jsonl` records `assignment_validation` and
   `assignment_affinity` stages on the next continuation request; those stages
   exist only in the new code.

**Done when:** GitHub Releases shows v0.1.117 with `latest.yml`; the installed
app reports 0.1.117; a spoken "tell the agent working on X to continue" against
a real Codex pane delivers to that pane or asks for its title, and never opens
a new pane.

### 1. Deterministic existing-owner shortcut — P1 (implemented September 11)

Implemented as `orchestratorOwnerMatch.cjs` plus a shortcut block in
`prepareTaskAssignments`, gated on agents-v1 and `assignmentMode: existing`
with no known work item. A unique title match reads the pane through the
router's own read path, reuses a work item already bound to that pane or
adopts one, and skips the model router and the affinity reviewer; ambiguous or
stale matches fall through to the router. Independent audit: matcher and
integration tests 33 pass; full suite 2,150 pass;
`orchestrator-routing-live.cjs --existing-owner` twice: 1 model call, about
2 seconds, one prompt to the owner, no creation (baseline this morning: 6
calls, about 34 seconds). Package 6's call budget of 3 is enforced by the
probe.

**Owners:** `orchestrator.cjs` `prepareTaskAssignments` (`:674-751`, insertion
between the reservation check at `:726-728` and the model routing at
`:734`), `orchestratorAgents.cjs` (`list`, `resolve`, `identity.name`,
`work.items[].title`), `orchestratorWorkItems.cjs` (adoption of a work item
for a directly started native task), `orchestratorTaskAffinity.cjs`,
`scripts/qa/orchestrator-routing-live.cjs`.

Today a continuation with no Orchestrator work item runs the router (three
rounds of `find_agents`, `read_agent`, `read_session`, `choose`) and then the
affinity reviewer, and only then hands off. The September 11 request cost six
calls and about 34 seconds; the router found the right agent in every trace.
The only deterministic reuse today is `:729-730`, which requires a known work
item. Tasks the user started directly in a pane never have one, so every
continuation of such a task is a full model routing.

**Product decision required:** this package treats a unique title match inside
the project as ownership evidence, which reverses the affinity reviewer's rule
that "a title alone cannot establish ownership." The justification: the title
is generated by the coding CLI from the task's own first prompt, the match is
scoped to one project and must be unique, the user named the task themselves,
and the reviewer that this replaces is the component that failed. The reviewer
stays for every case the shortcut does not claim.

1. Add a pure matcher `resolveTitledOwner({ instruction, candidates })` in a
   new small module. Tokenize the wake-stripped instruction and each
   candidate's `identity.name` plus work-item titles into lowercase words of
   three or more letters minus a short stopword list. A candidate is eligible
   when at least two of its significant title words and at least 60 percent of
   them appear in the instruction. It is chosen only when exactly one candidate
   is eligible, or the runner-up scores at least 0.3 lower. Names that are shell
   paths, provider defaults such as "Codex Web 8", or spinner-prefixed project
   names never match.
2. In `prepareTaskAssignments`, when `grant.args.assignmentMode === 'existing'`
   and there is no `known` work item, run the matcher over the live in-project
   agents from `agentDirectory.list()`. On a unique match: confirm
   `agentDirectory.resolve(agentId)` is still unique, perform the
   `read_session` read the application already performs at `:775` so
   `evidence` and `evidenceText` are seeded exactly as `:715-716` do, then adopt
   a work item bound to that pane with the agent title, the observed objective
   text and the session identity, and propose
   `{ kind: 'choose', decision: 'reuse', targetId, workItemId, reason:
   'unique-title-owner' }`. Because the proposal now carries a known work item
   with a verified binding, the affinity block at `:767` and the read check at
   `:809` are satisfied by the same evidence the router would have produced.
   Record `routing_progress | assignment_shortcut` with `matched`, `ambiguous`
   or `no-match` and the candidate count, nothing else.
3. On no match or an ambiguous match, fall through to the model router
   unchanged. The shortcut never creates a terminal and never runs under
   `assignmentMode` `auto` or `new`.
4. Because the adopted work item persists, the next continuation of the same
   task takes the existing `:729-730` path with zero routing calls.
5. Tests: a matcher unit test (unique, ambiguous, below threshold, stopwords,
   shell-path and default names, wake-prefixed instruction); an integration
   case in `orchestrator-agent-integration.test.cjs` where the routing
   `complete` stub asserts it was never called, exactly one prompt reaches the
   titled agent, and a work item is adopted; a second case where two agents
   share the words and the model router is invoked; a third where the matched
   agent's pane is gone at resolve time and the request asks for the title.
6. Extend `orchestrator-routing-live.cjs --existing-owner` with a fixture
   that has no work item and assert `calls <= 3`.

**Done when:** the live probe's existing-owner case completes in at most 3
model calls and under 15 seconds, sends exactly one prompt to the titled
agent, and adopts a work item; the ambiguous fixture still routes through the
model; `npm run test:orchestrator` passes.

### 2. Structured outputs for the four reviewers — P1 (implemented September 11)

Implemented as specified. `structuredOutput` in `orchestratorModelOptions.cjs`
gates on `supportedParameters`; each reviewer exports its schema; the five call
sites spread it and pass an explicit category; `completionWithFallback` drops
`response_format` once on HTTP 400/422 with `optionRepair` recorded.
Independent audit: focused reviewer, options and runtime tests 86 pass; full
suite 2,125 pass; `orchestrator-routing-live.cjs --existing-owner` three
consecutive runs with `google/gemini-3.8-flash` all delivered one prompt to
the existing owner and every affinity reply arrived as bare JSON.

**Owners:** `orchestratorModelOptions.cjs`, `orchestratorModelRuntime.cjs`,
`orchestratorTaskAffinity.cjs`, `orchestratorCloseSafety.cjs`,
`orchestratorGoalReview.cjs`, `orchestratorTargetReview.cjs`; call sites
`orchestrator.cjs:785`, `orchestratorInterpreter.cjs:102`, `:110`, `:127`,
`orchestratorGoalReview.cjs:21`.

Why not function tools: forced `tool_choice` is banned after the OpenRouter
timeout investigation, automatic tool choice cannot guarantee a call, every
reviewer today rejects a reply that carries `tool_calls`, and eight test
builders would need rewriting. OpenRouter's `response_format` with a strict
JSON schema keeps the reply in `message.content`, so the parse path and the
tests stay as they are. The public catalog lists `structured_outputs` for
`google/gemini-3.8-flash`, `inception/mercury-2.5` and the Claude models, and
the app already stores `supportedParameters` per model
(`orchestrator.cjs:946-949`).

1. Export a `SCHEMA` constant from each reviewer that encodes exactly the
   contract its validator enforces: affinity `{relation, userEvidence,
   workEvidence}` with the three-value enum; close review `{operations:[{operation,
   condition, count, evidence:[{sourceId, quote}]}]}` keeping `unclear` in the
   `condition` enum so the model retains its escape hatch; target review
   `{decision: ASSIGN}` or `{decision: DIRECT, evidenceIds}`; goal review
   `{decision: complete, evidenceIds}` or `{decision: continue}`.
2. Add `structuredOutput(model, name, schema)` to `orchestratorModelOptions.cjs`
   returning `{ response_format: { type: 'json_schema', json_schema: { name,
   strict: true, schema } } }` only when `model.supportedParameters` includes
   `structured_outputs`, otherwise `{}`. Spread it into the five call sites.
   Pass an explicit `category` option at each site so
   `orchestratorModelRuntime.cjs:20` stops labelling them `summary`.
3. In `completionWithFallback`, treat `response_format` like `reasoning` at
   `orchestratorModelRuntime.cjs:33`: on the first HTTP 400 or 422, drop it and
   retry once. Keep `parseModelJson` as the fallback parser for models without
   structured outputs and for the downgraded retry.
4. Tests: `orchestrator-model-options.test.cjs` gates on the parameter list;
   `orchestrator-model-runtime.test.cjs` proves the 400 downgrade retries once
   without `response_format` and never retries a write; each reviewer test adds
   a case that the exported schema accepts its own valid fixtures and rejects
   an extra key (validate with a small JSON-schema check in the test, no new
   dependency).

**Done when:** the four reviewer test files and `npm run test:orchestrator`
pass; `node scripts/qa/orchestrator-routing-live.cjs --existing-owner` passes
three consecutive runs and its report shows the affinity reply as bare JSON on
every run; diagnostics record a stable category for each reviewer.

### 3. Operator protocol: the application observes, the model acts — P1 (implemented September 11)

Implemented: `send_prompt`, `answer_question`, `permission` and `interrupt`
with no observation token and no eligible earlier read are observed by the
application inside the executor and bound by an explicit token; the schema no
longer advertises `stepId` or `observationToken` for those four;
`terminal_interact` and `finish_terminal` keep the model-must-read rule;
composer evidence within 10 seconds of a task write becomes
`submitted-observed` and replaces the 60-second unconfirmed-start report; the
unconfirmed-start report records bounded startup telemetry. Limits recorded by
the implementer: composer evidence arrives only when the pane is read inside
that window (the delegated handoff's post-read does this), and an
application-observed write is structurally drift-free because nothing awaits
between the read and the write. Independent audit: focused operator, schema,
report and task tests 117 pass; full suite 2,150 pass.

**Owners:** `orchestratorWorkspaceExecutor.cjs:271` and `:289`,
`orchestratorOperator.cjs` (`latest` `:53-62`, `authorize` `:66-91`),
`orchestratorAutomaticHandoff.cjs` (the precedent), `orchestratorToolSchema.cjs`,
`orchestratorTaskReports.cjs:91-92`, `orchestratorTasks.cjs:397-403`,
`orchestratorPromptReadiness.cjs`.

Since the September 8 repairs, terminal-input rejections in the saved receipts
are not screen churn. They are the executor model failing the observation
protocol: acting with no read at all (`orchestratorWorkspaceExecutor.cjs:271`),
a missing or consumed token (`orchestratorOperator.cjs:66`), or a reused step
id. The application already knows how to observe on the model's behalf: the
automatic handoff drives a `read` phase and then supplies
`observations.latest(...)` as the token in the `send` phase, and busy-prompt
promotion reads and binds `observationSequence` itself
(`orchestratorIntegration.cjs:362-376`). Separately, "input was sent, but I
could not confirm that the agent started" is a 60-second timeout on an empty
`observedState`; the only producers need hook-attributed turn identity, so a
pane whose hook event is late or missing always reports unverified.

1. Auto-observe for composer actions. When the executor issues `send_prompt`,
   `answer_question`, `permission` or `interrupt` with no `observationToken`
   property and `latest()` finds no eligible read, perform the `read_session`
   read inside the executor as a synthetic earlier round, mint the token, and
   authorize the action with it explicitly. Keep `terminal_interact` with keys
   or mouse and `finish_terminal` on the model-must-read rule, because those
   require the model to have seen the screen. Keep every existing rejection for
   an explicit-but-invalid token (`Object.hasOwn` at `:289` is pinned) and for
   drift after the read (`orchestratorOperator.cjs:81`); the fence semantics do
   not change, only who supplies the observation.
2. Drop `observationToken` and `stepId` from the model-facing schema for the
   four auto-observed operations in `orchestratorToolSchema.cjs`, and shorten
   the operator prose at `:40`. The application generates the step id as it
   already does for omitted ones. This also shrinks the serialized tool schema
   that package 5d counts against the input ceiling.
3. Startup evidence from the composer, not only from hooks. After a task
   submission write, the readiness decoder in `orchestratorPromptReadiness.cjs`
   can observe that the submitted text left the root composer and the
   provider's busy indicator appeared. Record that as `observedState:
   'submitted-observed'` within 10 seconds of the write, so
   `orchestratorTaskReports.cjs:92` reports "the prompt was accepted; result
   pending" instead of an unconfirmed start. Hook attribution still upgrades it
   to a full turn; a composer that still shows the text after 10 seconds keeps
   the unconfirmed report.
4. When the unconfirmed-start report does fire, record the session's
   `turnState`, `turnId`, `turnStartedAt` and whether the provider's hooks are
   installed in the private diagnostics, so the next occurrence is diagnosable.
5. Tests: `orchestrator-operator.test.cjs` gains cases for `send_prompt`
   without any read (auto-observed and written), `terminal_interact` keys
   without a read (still rejected), explicit invalid token (still rejected),
   and drift between the auto-read and the write (rejected). A task-report test
   covers `submitted-observed`. The 29 files that pin token rules are re-run
   unchanged except where they asserted the old rejection for the four
   auto-observed operations.

**Done when:** `scripts/qa/orchestrator-live-tasks.cjs` against real Codex and
Claude panes shows zero "Read this terminal before operating it" receipts for
`send_prompt`, every delivered prompt confirmed within 10 seconds, and
`npm run test:orchestrator` passes.

### 4. Retire the legacy harness path — P2 (implemented September 11)

Implemented: the `agentHarness` option, `shadow` mode, `useAgentHarness`,
`isAgentRequest()`, per-task `harnessVersion`, `internalHarnessVersion` and
their propagation are gone; the legacy routing tool and the schema option are
removed; `LINA_ORCHESTRATOR_HARNESS` is ignored; saved records tagged `legacy`
load on the single harness (new store test). Flipping the constructor default
alone failed 94 tests in 24 files; all were migrated with per-file counts
unchanged and no deletions, and the materially rewritten cases are listed in
the implementer's report (unread-reuse became unverified-reuse because the
application now reads the candidate itself; clarification flows moved to a
model-operated grant because a bound handoff cannot ask the user; three
dependency tests assert the prerequisite read by turn identity). Independent
audit: zero harness references in backend, frontend and preload; suite 2,157
pass; `tsc --noEmit` clean; routing probe still 1 call.

Two production facts this exposed, both already true for the installed app
because its integration defaulted to agents-v1: a 16k-token brain model can no
longer fit an ordinary request (the agents-v1 tool surface serializes larger;
readiness minimum measured at 24,589 tokens), and a model that never replies
after a bound delegation burns the stagnation limit before the honest close
text is used. Both are recorded as follow-ups, not fixed here.

**Owners:** `orchestrator.cjs` (19 `isAgentRequest()` branches, 11
`harnessVersion`, 7 `useAgentHarness`, 9 `'legacy'`, 2 `'shadow'`),
`orchestratorIntegration.cjs:741`, `orchestratorToolSchema.cjs` (`agentHarness`
option), `orchestratorAgentContext.cjs`, `orchestratorConversationStore.cjs`,
`orchestratorInterpreter.cjs`, `orchestratorPlannerTools.cjs`,
`orchestratorRoutePlanner.cjs` (legacy `ROUTING_TOOL`),
`scripts/backend/orchestrator-agent-fixtures.cjs`.

The production path (`orchestratorIntegration.cjs:741`) defaults to
`agents-v1`. `createOrchestrator` itself defaults to `shadow`
(`orchestrator.cjs:103`), which runs the legacy behaviour with the agent
directory observed but never used. Only 1 of the 69 test files that call
`createOrchestrator` sets `agents-v1`; the other 68 assert legacy behaviour.
That is the cost of this package, and it is also why fixes keep landing in one
path only.

1. Flip the `createOrchestrator` default to `agents-v1`, run
   `npm run test:orchestrator`, and record the failing file count as the
   migration inventory. Do not change behaviour in this step.
2. Migrate the fixtures file by file so each test asserts agents-v1 behaviour:
   named workspace tools instead of the single `workspaceTool`, `find_agents`
   routing reads, binding-filtered work items. Where a legacy assertion has no
   agents-v1 equivalent, delete it and say so in the commit message.
3. Delete the legacy branches: the `isAgentRequest()` ternaries, the
   `harnessVersion` propagation through deferred submit, resume and retry
   (`orchestrator.cjs:1698`, `:1749`, `:1754`), the `shadow` mode, the
   `internalHarnessVersion` input, the legacy `ROUTING_TOOL` and the
   `agentHarness` option on `scopedWorkspaceTool`. Saved tasks and work items
   that still carry `harnessVersion: 'legacy'` load as agents-v1; add a load
   test with a legacy-tagged saved record.
4. Update `docs/orchestrator-controls.md` and `docs/orchestrator.md` to drop
   the dual-harness language.

**Done when:** `grep -c "isAgentRequest()\|harnessVersion\|useAgentHarness\|'shadow'"
apps/desktop/backend/orchestrator.cjs` is 0; the suite passes; the package diff
removes more lines than it adds; `node scripts/qa/orchestrator-smoke.cjs
--hidden` and the routing live probe pass.

### 5. Observability and voice hygiene — P2 (implemented September 11)

Implemented: `voice_inference` stream, completion and inference records go to
`logs/voice-inference.jsonl` through a second diagnostics instance (error
records stay in the main file); the generic interpretation message is kept for
`state.error` and speech while the system message appends `Reason:` with the
validator text and a bounded `lastFailure` reaches the planner and executor
context for the next turn; `shared/voiceWakePhrase.cjs` strips every accepted
greeting on wake, held and answer captures and `voiceDismissal` accepts the same
forms; `modelInputBudget` uses a 96,000-byte ceiling at or above 131,072 context
tokens. Independent audit: full suite 2,125 pass including the new retention,
reason-recall, wake-table and budget-tier tests.

**5a. Voice telemetry out of the error log.** Owner `voiceController.cjs:151`,
`voiceInferenceService.cjs:116`, `orchestrator.cjs:105`,
`orchestratorDiagnostics.cjs`. The stream record fires every 50th 20 ms frame,
about once a second while hands-free listens. Create a second diagnostics
instance with filename `logs/voice-inference.jsonl` and route `voice_inference`
stream and completion records there; keep `error` records in the main file.
Done when a diagnostics test proves a `voice_inference` stream record never
lands in `orchestrator-errors.jsonl`, and a simulated three days of listening
leaves request records intact.

**5b. Show the validator's reason.** Owner `orchestratorInterpreter.cjs:217`,
`orchestrator.cjs:1676`, `orchestratorReplyContext.cjs`. Keep the spoken text
and the exact generic string (pinned by `orchestrator-semantic.test.cjs:142`),
but attach the last `repairReasons` entry as `error.detail` and write it into
the system message after the generic sentence. Record `{requestId, stage,
reason}` as the last failure in the reply context so `plan_conversation` can
answer "what was that error?" from it. This is the narrow slice of package 1 in
`docs/orchestrator-repair-plan-2026-09-10.md`; do not build the full facts
projection here. Done when a failed interpretation produces a system message
with the validator reason and the next conversational turn can repeat it.

**5c. Strip every accepted wake pronunciation on every input path.** Owner
`voiceController.cjs:456`, `voiceWakeVerifier.cjs:8`, `voiceDismissal`. Extend
the strip to the verifier's forms (LINA, LENA, HE LENA, HELINA) and to the
transcription forms seen in the saved history (Alina, Elena), and apply it on
`ptt` and `answer` sources as well as `wake`. This reverses a deliberate pin in
`voice-handsfree.test.cjs:481` and `voice-dismissal.test.cjs:7`; the product
reason to keep the asymmetry no longer holds once push-to-talk is the primary
path and users still say the name. Done when the four-case table and the
dismissal test are updated and the routing live probe's `currentInstruction`
never begins with a greeting.

**5d. Scale the input ceiling with the model.** Owner
`orchestratorBudget.cjs:7`, `orchestrator-budget.test.cjs:8`,
`orchestrator-model-readiness.test.cjs:37`. Replace the flat 48,000 with
48,000 for windows under 128k tokens and 96,000 above, keeping the same
`context - output - 1024` bound. The readiness preflight at
`orchestrator.cjs:1792` inherits it. Done when the budget test pins both
tiers and the three-in-a-row context failures from September 9 cannot recur
with a large-page read under the configured model.

### 6. Measure and hold the line — P2

**Owner:** `scripts/qa/orchestrator-routing-live.cjs`,
`scripts/qa/orchestrator-latency-bench.cjs`, `docs/orchestrator-deep-dive-2026-09-11.md`.

Every live probe report already carries `calls`, `spent` and `elapsedMs`. Add
a per-case budget: continuation to an existing owner must complete within 3
model calls after package 1 and within 15 seconds; new-task delegation within
4 calls. Print the budget beside the actuals and fail the probe when exceeded.
Record the baseline (6 calls, 34 seconds on September 11) in the deep-dive doc.

**Done when:** the probe fails on a regression to the old call count, and the
documented baseline is superseded by a measured number after package 1.

### 7. Findings surfaced by verification (added September 11)

`node scripts/qa/orchestrator-live-tasks.cjs` (in-memory adapters, live
model) exposed two defects that predate this plan:

- **Concurrent pending-command race.** The planner context filtered pending
  jobs on a live pending command, then mapped them many awaits later; a job
  that finished in between cleared its command and the interpreter crashed on
  a null entry. Present at the last commit. Fixed the same day at the map site
  with a race-reproducing integration test.
- **Dependent request executed twice.** A request submitted as "after that
  review finishes, tell Atlas to fix the findings" while the review was still
  routing was interpreted as a deferred instruction without a dependency. The
  validator rejected it with "A deferred instruction requires an initial
  terminal task", the repair added an immediate initial task that duplicated
  the deferred one, and the fix prompt reached the pane twice (turns 7 and 8
  in run `1789158974348-60360`) with the review result never used. Before the
  race fix this scenario crashed instead. Repaired the same day: the validator
  message steers the repair toward `dependsOnRequestIds` on the pending request
  when pending commands exist, a repaired plan whose deferred text duplicates
  its initial task is rejected, and the planner guidance names the separate
  pending-request case. Independent audit: validator and repair tests 41 pass;
  `orchestrator-live-tasks.cjs` run `1789159860199-62052` passed all four
  scenarios, including review-then-fix with a single dispatch.

- **Gemini "Corrupted thought signature" on continued requests (agents-v1
  only).** Once the live-tasks probe ran the single harness, two of its four
  scenarios failed with HTTP 400 from Gemini on the executor call that follows
  the model's `respond` tool when a grant remains (a dependent fix, a
  clarification answer). The suspect is the application-synthesized assistant
  tool-call turn (`orchestrator.cjs` around line 1723) replayed next to a signed
  model turn. This affected the installed app all day and was hidden while
  tests ran the legacy default. Handled as package 8 (see below).

The probe's own fixture also had to be brought up to the native evidence
contract (screen sequence and input revision per pane), which is why it could
not have passed since that contract became mandatory on September 10.

### 8. Gemini reasoning-signature replay — implemented September 11

**Owners:** `orchestratorModelRuntime.cjs`, `openRouterErrors.cjs`,
`orchestrator.cjs` (unfinished-work continuation), `orchestratorDiagnostics.cjs`,
`scripts/qa/orchestrator-live-tasks.cjs`.

Captured with an env-gated body dump (`LINA_MODEL_DEBUG_DIR`, off by default):
the rejected history was byte-identical to the preceding accepted call except
that it now interleaved three model turns carrying `reasoning_details`
(`reasoning.encrypted`, `google-gemini-v1`) with two application-authored
assistant turns carrying none (the synthesized handoff observation and the
echo of a synthesized reply). Gemini refuses that mixture. Fix: the runtime
sends a request with no replayed reasoning whenever any assistant turn lacks
it, recorded as `reasoningReplay: aligned`; a bounded one-time retry without
reasoning remains for a provider rejection that names the signature. Fixing
that unmasked "Requests ending with a model turn are not supported": the
unfinished-work repair no longer echoes the reply as an assistant turn and
quotes it inside its system note instead. Provider error text stays internal
(`providerMessage`, never surfaced). Independent audit: runtime, semantic and
diagnostics tests 49 pass; live-tasks run `1789166015679-56384` had zero 4xx
model calls. The remaining probe failures in that run were the fixture not
modelling live-pane fields that the application's auto-finish requires;
see the final probe result below.

Final result: with the fixture panes reporting what a running Codex pane
reports (`processState`, `agentProcessState`, `agentPid`, `observation`,
`started`, `launchToken`, `conversationId`), live-tasks run
`1789166628885-54324` passed all four scenarios with zero 4xx model calls. In
two of eleven delegated requests the model ended with `respond` instead of
`finish_terminal`; the application's delegated-finish fired in both, proven by
a pass-through wrapper recorded in the probe report. That model habit did not
occur under the retired harness and is recorded as a prompt-compliance
follow-up, harmless while the application's own finish covers it.

## Dependencies and sequencing

- 0 first. Nothing else is testable in the installed app until it ships.
- 2 and 5 are independent of each other and of 1 and 3; they can run in
  parallel on separate branches.
- 1 before 3: the shortcut removes most routing calls, which changes what the
  operator path sees.
- 4 last among the code packages. It is the largest churn and every other
  package lands in fewer places once the legacy path is gone, but it should
  not block the P1 items.
- 6 lands with 1 so the new call count is captured as soon as it exists.

## What this plan does not do

- No new reviewer, fence or clarification prompt. If a package needs one to
  pass its done-when, the package is wrong.
- No return to forced `tool_choice`.
- No change to grant authority, observation-token semantics for user-typed
  terminals, or close safety. Package 3 changes who supplies the evidence,
  not what evidence is required.
- No investigation doc for the next incident without first landing one of the
  packages above.
