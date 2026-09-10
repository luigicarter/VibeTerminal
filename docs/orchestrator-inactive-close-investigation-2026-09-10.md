# Inactive-terminal closure and recent interpretation errors

September 10, 2026. Source repair on version 0.1.113; no installation or release.
Evidence came from the installed conversation, close receipts, rotating diagnostics,
and the installed package. The installed version was 0.1.113. Its interpreter,
intent, planner prompt and close-scope modules matched the pre-change checkout
after newline normalization. Private transcripts, credentials and pane identifiers
are not copied into this document.

## What happened

At approximately 10:38–10:39 Toronto time, the user requested cleanup of terminals
that were not working, corrected the proposed count, then asked to close three
inactive terminals. The assistant's preceding description included a running pane
with pending submission among its proposed cleanup targets, alongside panes with
unknown or awaiting-activity status. It accepted the count correction without
establishing a verified three-pane selection.

The final request selected three explicit pane IDs. All three receipts confirmed
pane removal and stopped processes. This was an actual closure, not a display-only
removal or an unverified success message. The receipts preserve the exact original
launch/generation identities. They do not establish that the selected panes met
the user's inactivity condition. The earlier assistant description is evidence of
its contradictory reasoning, not a retained raw runtime snapshot at closure time.

The existing close implementation correctly froze the selected pane identities,
excluded replacements and verified termination. It did **not** validate the
inactivity restriction. A correctly executed close on the wrong selection could
therefore receive the normal completion cue. This is distinct from the earlier
[close-scope and termination-verification repair](orchestrator-recovery-review.md).

Two immediately preceding errors also remain visible in the diagnostics:

- **10:36, voice-behavior question:** the model initially returned no valid
  planning calls. Its retry selected task-status without known terminal targets.
- **10:37, question about that error:** the model proposed an invalid task-status
  plan and then a command without valid session IDs. Neither request dispatched
  terminal effects. These were interpretation/contract failures; the retained
  evidence does not attribute them to microphone failure or unclear user wording.

Earlier documented failures include local context overflow and lost feature-request
continuity ([conversation audit](orchestrator-conversation-errors-2026-09-09.md)),
unrelated existing-terminal selection ([ownership audit](orchestrator-task-ownership-review.md)),
and schema/semantic repair competing for one retry
([architecture review](orchestrator-architecture-review.md)). Their prior repairs
did not cover this conditional-close selection gap.

## Source changes

`orchestratorCloseSafety.cjs` adds a bounded, read-only semantic review before a
production close plan can dispatch. It receives user instructions, related user
replies, proposed targets and the project ID/name mapping. Assistant suggestions
cannot provide authorization. Every proposed close needs a complete reviewed
decision with quotes that match supplied user text. A review cannot add targets,
replace the proposed selection or dispatch effects. Malformed/inconclusive review
or a count mismatch yields clarification before any sibling effect.

The application stores the reviewed inactive-only condition in the frozen close
scope. Positive runtime evidence is required; running work, pending input or
questions, children/background work, pending launches and unknown/unavailable
activity do not qualify. The condition survives continuation. Eligibility is
checked again before grant dispatch and after the integration adapter refreshes
inventory. If a remaining target begins work during a multi-pane closure, further
closure is blocked and earlier completed effects remain accounted for.

Native unsent typing has a separate check. `terminalObservation.inputState`
returns only current generation-bound input metadata without copying or parsing
screen history. The final native close boundary rejects occupied or unverified
input state for an inactive-only request. This does not introduce terminal polling
or model reads of the user's draft.

Explicit unconditional project/group or named-pane closures remain available,
including busy panes when covered by that user instruction. Existing identity,
launch-settlement, process-stop and partial-result checks remain in force.

`plan_conversation` gives ordinary capability, history and error questions an
explicit zero-effect planning path. It cannot mix with operations, terminal
targets or continuation. `read_workspace` now supplies actual voice capability
facts: questions can open a temporary answer window, completed replies return to
standby, and there is no always-listen-after-every-reply setting or settings-change
tool. These changes do not implement a new voice preference.

## Verification and boundaries

- Focused tests cover the reported running/unknown three-pane proposal, exact
  inactive selection, unrestricted busy-pane closure, count mismatch, incomplete
  review, network failure, continuation, changing activity, stale generations,
  native unsent input and passive error questions.
- `npm run check:orchestrator` passed the backend, frontend, build, telemetry,
  voice, isolated Electron navigation/task UI and session-resume checks. All
  **1,993 final backend tests passed**, recorded in
  `.tmp/orchestrator-close-safety-final-tests.log`.
  The existing Vite large-bundle advisory remains.
- Configured `inception/mercury-2.5` probes used synthetic projects, history and
  dispatch adapters. The forced unsafe proposal was blocked with zero effects;
  the natural history-based request asked for clarification with zero effects.
  Valid project closure stopped all eight fixture panes; named-subset closure
  stopped exactly two and preserved six. The added review initially lacked the
  project-name mapping and refused valid project closes; adding that mapping
  repaired the reproduced refusal. Failed probe artifacts remain retained.
- Ordinary voice-behavior and error questions used `plan_conversation` without
  interpretation failure or terminal effects. **Their free-form answers remain
  unreliable:** probes still invented a clarity-based cause or suggested an
  unverified settings option. Passing the planning contract is not certification
  that these explanations are correct. No new transcript-based error classifier
  or automatic voice-mode change is claimed.
- The inactivity condition is classified by a separate model review. Exact quote
  validation and runtime enforcement do not constitute a complete natural-language
  proof. Other lifecycle operations are not newly covered by this close-specific
  review. Native drafts have the decoder check; structured chat draft ownership
  is not independently verified by that native mechanism.
- No installed files, saved conversations or user terminals were changed by this
  investigation. The changes protect the source candidate, not the already
  running installed process. No old task or closed terminal was replayed.

Local configured-model evidence under `.tmp/orchestrator-recovery-live/`:
`1789052363015-46424` (final unsafe close guard), `1789051996813-26708`
(natural conditional-close history), `1789052363014-48832` (project close),
`1789052238509-41916` (explicit subset), and `1789051998921-48316` /
`1789051999944-20488` (ordinary questions; planning passed, answer-quality limits).
These are small acceptance samples, not a measured production reliability rate.
