# Orchestrator repair plan — September 16, 2026

Status: implemented in the source checkout, with source, native and packaged
verification recorded in [the implementation review](orchestrator-repair-implementation-2026-09-16.md).
The original Codex Web timeout's exact cause remains unproven; its native TUI
startup passed the isolated probe, and future failures now retain their blocker.
No release or installed-app replacement was performed.

Evidence: [incident review](orchestrator-incident-review-2026-09-16.md).
The latest incident occurred on installed 0.1.125. Earlier dropped-clause,
warm-spare and ownership repairs remain regression requirements. Preserve all
existing checkout changes, including the pending launcher guard and Chats UI.
Implementation and tests belong to `apps/desktop`; engineering records remain
in `docs`, following the root and desktop `AGENTS.md` ownership rules.

## Required behavior

- Resolve uncertain launcher names and pane count before any creation. A
  clarified request retains its project, task, restrictions and literal text.
- After an authorized multi-pane request, a failed launch must not prevent an
  independent, successfully bound pane from receiving its task.
- Preserve requested ordering and dependencies. A step requiring a failed
  predecessor remains blocked; never infer that all actions are independent.
- Retry only unfinished work. Never duplicate a pane or resend a prompt whose
  delivery is confirmed or uncertain. Revalidate pane identity on recovery.
- Report each affected pane's creation and delivery accurately, with one
  explanation per failure. Creation and submission never imply completed work.

## 1. Establish regressions and repair the pending guard

Primary files: `backend/orchestratorReference.cjs`,
`backend/orchestratorInterpreter.cjs`, and the existing create-launcher,
reference and unknown-launcher-clarification tests under `scripts/backend`.

1. Preserve the exact morning sentence as a regression. Assert no terminal
   effects before clarification, including no supported sibling created while
   another requested recipient remains unresolved.
2. Review the existing `unresolvedOpeningLauncher` against the shared reference
   parsing and voice normalization. Reuse those rules; avoid introducing an
   independent parser with different alias/project/payload semantics.
3. Cover known spoken aliases, Codex versus Open Codex versus Codex Web,
   project names, generic shell/blank panes, negation, quotations, worker
   payloads mentioning opening, and genuinely requested multiple providers.
   Unknown terms require clarification, not new guessed aliases.
4. Carry clarification through the existing pending-request continuation.
   Test answers identifying one provider, explicitly correcting to one pane,
   requesting two panes, remaining ambiguous, and cancelling. If pane count
   remains uncertain, resolve it before effects. Preserve the whole original
   objective and do not delegate launcher instructions to the worker.
5. Fix the new test's premature file read: assert live behavior through
   `getState()`. Verify persisted history separately after the real store drain
   or awaited `dispose()`. Do not add sleeps or weaken the assertion.
6. Update existing unknown-launcher fixtures deliberately: raw-text ambiguity
   may now be caught before a model call, while a model that invents an unknown
   launcher from otherwise valid input must still exercise schema rejection.

Gate: exact incident clarifies with zero effects; its corrected continuation
creates only the requested panes and submits each intended prompt once.

## 2. Isolate launch failures within a request

Primary files: `backend/orchestrator.cjs` (`bindTaskAssignments`, execution,
failure settlement and recovery), `backend/orchestratorIntent.cjs`, and the
existing routing/work-item state modules as needed.

1. Replace the first-failure throw in assignment binding with outcomes per
   grant. Collect and retain every acknowledged creation, including later
   siblings, regardless of completion order.
2. Bind successful grants through the existing identity and ownership checks.
   Record failed grants with their work-item and creation identities; keep
   failed or unresolved grants outside executable authority without removing
   them from the durable request history or unfinished-work record.
3. Execute only successfully bound grants whose dependencies are satisfied.
   Keep the existing dispatcher and bounded startup waits; a scheduler rewrite
   is not required for this repair.
4. Settle work items individually. A sibling launch failure must not mark a
   successfully submitted task failed or stop its result monitoring. The
   aggregate request must retain the failed/unfinished portion and report a
   partial outcome rather than unconditional success.
5. Preserve cancellation, input ownership, generation, launch-token and native
   conversation checks. Cancellation must stop future sends while retaining
   receipts for panes that finish opening afterward.

Gate: first pane succeeds/second fails and first fails/second succeeds both
deliver independent work once. All-failed requests send nothing. Explicit
dependencies remain blocked. Reversed completion order produces the same
ownership and delivery results.

## 3. Make retry and partial reporting agree with recorded effects

Primary files: recovery paths in `backend/orchestrator.cjs`,
`backend/orchestratorRouting.cjs`, `backend/orchestratorFinalResponse.cjs`,
and `backend/orchestratorFailureText.cjs`.

1. Extend existing exact-pane recovery rather than adding a second retry path.
   Preserve action/grant identity across clarification and retry. A later
   authorized retry reuses the original timed-out pane only when its generation,
   launch token and conversation binding still match.
2. Completed siblings never re-enter the unfinished command. An uncertain write
   stays uncertain and is not resent. Merely noticing that a timed-out pane is
   now ready must not silently submit the previously failed task.
3. Test close/restart, competing ownership, cancellation, multiple follow-ups
   and persisted/restored requests. Missing evidence after restart must not
   become permission to recreate or resend automatically.
4. Compose the response once from per-grant outcomes. Remove the path that
   appends the same raw exception after the receipt-derived explanation.
   Resolve pane names through retained creation identity even when a timeout
   lacks a verified target. Voice and visible replies must agree.

Expected example, when independent work was actually submitted:
“Sent the investigation to Open Codex. Codex Web opened, but startup could not
be confirmed, so its prompt was not sent.” If submission is unconfirmed, say
so instead of claiming that the agent started.

Gate: a retry targets only remaining work and sends nothing twice; responses
name every affected pane, state delivery, and contain no duplicate errors.

## 4. Diagnose and repair Codex Web startup from evidence

Primary files: `backend/orchestratorLaunchers.cjs`,
`backend/orchestratorIntegration.cjs`, `backend/orchestratorPaneReadiness.cjs`,
plus existing launch integration/native readiness tests and QA harnesses.

1. Capture bounded startup diagnostics: phase, elapsed time, last shared
   readiness reason, inventory presence, process/launch state and identity
   availability, linked to request/grant/pane/generation/launch token. Record
   transitions and final failure, not every poll; omit raw terminal contents
   and credentials from routine logs.
2. Distinguish routing/process startup from decoded composer readiness in
   errors. Preserve known created-pane identity for diagnostics and recovery
   without treating it as authority to type.
3. Replay Codex Web startup in a scratch profile: foreground/background pane,
   slow startup, missing process identity, provisional first-turn identity,
   trust/login/setup screen, exit, and successful empty composer. Use scripted
   provider processes for deterministic failures before a real-provider probe.
4. Repair the specific failing predicate or lifecycle transition only after
   reproduction. Preserve the shared readiness contract. Increasing the timeout
   or relaxing input guards is not justified by the current evidence alone.
   If the pane genuinely needs login/setup, report that blocker accurately.

Gate: every timeout has an actionable phase/reason; the reproduced defect is
fixed with a regression, or the real external blocker is clearly documented.
Mocked passes alone cannot establish that actual Codex Web startup is fixed.

## Verification and delivery

Run focused tests after each phase, then once the combined change is stable:

- Full `npm run test:orchestrator` and `npm run test:frontend` from
  `apps/desktop`; `npm run build` includes TypeScript and the production build.
- Root repository-boundary checks and `git diff --check`.
- Isolated Electron command, background-launch, navigation and task-UI smokes;
  use the existing hosted Windows gates if local app launches are constrained.
- Extend the completion ladder with the incident/clarification, mixed-launch
  failure, exact retry and cancellation scenarios. Retain earlier checks for
  close/open/Hi completeness, no unsolicited spare, same-pane follow-up and
  routing-title replies.
- Verify source and packaged behavior separately, including the real Codex Web
  startup boundary. Record exact commands, results and remaining limitations.

Implementation completion means the above behavior is verified and documented.
A release, installer replacement or restart is a separate delivery step; this
planning request performs none of them. Do not rewrite the live profile or
historical ownership records as part of these repairs.
