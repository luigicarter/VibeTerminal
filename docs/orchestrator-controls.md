# Orchestrator and terminal controls

The current [harness overhaul](orchestrator-harness-overhaul.md) adds semantic
inspection and folder controls, application-managed inspection completion, and
project removal that preserves files. It supersedes older external-folder and
model-finish limitations described in historical reviews below.

## Conversation and recovery

Vibe's response contract calls for a warm, direct voice, brief useful replies, and
no parroting of the request. Voice history listings offer at most three relevant
choices unless the user asks for more. Once every requested orchestrator action
is confirmed complete, the reply is `done`; voice commands add a short ding
before speaking that word. Queued or unconfirmed delivery, blocked or failed
actions, questions, task-status requests, and terminal inspections keep their factual explanations.
Sending a prompt completes the send command; the agent's work remains tracked
separately. The conversation omits routine completion and missing-result notices
and shows one result per identified terminal turn, retaining associated request
numbers. Failures and questions remain visible and audible.
Full action receipts preserve execution and verification details.

Terminal creation details use a human terminal/provider label and the
confirmed project folder's name, such as “Opened Codex in vibeTerminal.” Shell
executable titles and full drive paths are excluded from creation replies in both
direct and model-driven execution. The full confirmed directory remains available
in action evidence for an explicit location question.

Submission replies and operator finish receipts use the request's own delivery
and turn evidence. A written prompt does not prove that the agent accepted or
started it. Running wording requires an attributed current turn; a replacement
terminal or an older active turn cannot certify the request. The final publication
check also covers model-written replies and late queued-delivery rejection.

Spoken replies retain the exact request they follow, including its question and
bounded exchange context when unrelated work has moved it outside recent history.
This context helps resolve follow-ups; it does not revive completed grants or turn
assistant suggestions into authority. Topic changes remain new instructions.
Delivery corrections retain the original request and terminal generation through
later status answers. A validator-rejected attempt to replay an already submitted
task can recover as a read-only delivery check; it cannot recreate consumed grants
or resend uncertain input. An unfinished, unconsumed operator objective retains
its existing recovery authority and constraints.
Regression verification for these fixes passed 1,061 Orchestrator/voice tests
and the production renderer build. Scripted text/voice cases reproduce the two
historical correction-validation failures and verify a single prompt dispatch.
These checks cover source behavior; the installed application and live provider
interpretation were not exercised by this run.

Read-only result explanations can recover earlier invalid-tool or stale-history
attempts after retrieving usable content. Reads of another identified terminal,
unavailable observations and failed actions remain failures. Failed terminal
observations do not issue usable observation tokens. Draft status retains the
delivery reason and tells the user where to review and submit it.

Additional September 7 checks reproduced the installed paste/submission failure
with a disposable native Codex process and confirmed four successful source
submission cases (interaction/input, raw/bracketed paste). Hidden Electron checks
passed background creation, project-name acknowledgments, immediate shell input,
remount and restart. Configured-model checks passed safe input clearing and a
review request against disposable adapters; the review was checked independently
because selecting it immediately after the draft-edit fixture leaves that fixture
in draft mode. Physical voice capture and deployment to the installed application
remain outside these checks.

Structured choices accept explicit natural replies such as “the second one” and
“go with option two” without another clarification. Qualified or ambiguous answers
still go through the Orchestrator, and permission decisions retain their explicit
vocabulary. Custom answers can be spoken naturally without a special prefix.

The intent schema describes each command's own fields. A failed interpretation
gets one repair with the validator's reason and the original user context, without
echoing malformed model arguments. Execution advertises read/conversation tools
and the request's granted effects through closed per-operation field lists. Shared
field definitions keep schemas small; default excerpts also account for the space
left by the instruction and tools. Unread pages never advance saved bookmarks.

The active model exchange preserves opaque `reasoning_details` and tool-call
metadata, as required by [OpenRouter's reasoning continuity contract](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
These blocks stay in that request's memory; they are excluded from saved chats,
diagnostics and speech. The earlier recorded HTTP 400 did not retain its raw
provider explanation, so its precise cause cannot be established retrospectively.

Finishing an operator interaction still requires an unused, recent observation
after its last action, with the same terminal generation. Background runtime
revision changes do not invalidate this non-input completion report. Input effects
retain their freshness checks, and uncertain delivery cannot be retried or reported
as completed. Native operator sends and interrupts may omit counter copies already
bound by their validated observation token. The app fills only those missing
transport fields after claiming the original action; explicit mismatches still
fail, and the action's replay identity does not change.
See [voice turns and saved-title confirmation](orchestrator-tasks.md)
and [project/global work history](orchestrator-dashboard.md) for the related flows.

September 7 verification: 642 backend/voice regressions, the renderer build,
voice capture/frontend checks and isolated Electron dashboard QA passed. The
parent inspected global, project and closed-terminal table screenshots in
`.tmp/orchestrator-dashboard-smoke/1788813730138-58912/`.
Configured-model checks in
`.tmp/orchestrator-conversation-live/1788814088933-51728/report.json` exercised
a single commit-review submission through changing completion telemetry, a spoken
title mismatch, and its request-owned affirmative resume. Earlier cases also
checked concise history/greeting replies and explicit conversational listening.
These used disposable terminal/history adapters; physical microphone capture and
live coding-agent behavior were not exercised. Changes are in source and the
local renderer build, not the installed release.

See [conversations and tasks](orchestrator-tasks.md) for request ownership,
scheduling, dependencies, recovery and saved history.

The Orchestrator carries out a user objective across identified terminals. Users
can delegate a review, navigation, terminal settings changes or a sequence of
answers without supplying a keystroke script or special command syntax.

## Interpretation and persistent execution

Operator grants bind `lifecycleMode`: `preserve` by default, `interrupt` for
explicitly stopping current work, and `exit` for explicitly quitting/closing.
Clearing text preserves the agent and cannot use quit/suspend shortcuts. Native
edits require the same agent to remain alive before a completed report;
interruption cannot repeatedly send Ctrl-C to an idle or already-interrupted turn.
Named key casing is normalized before authorization without expanding the key
vocabulary. See [the terminal exit review](orchestrator-exit-review.md) for the
recorded incident, evidence limits and regression coverage.

For a task without an explicit terminal, `delegate_task` authorizes bounded
assignment in a known project. Read-only discovery selects a suitable conversation
or configured new agent before an application-only transition creates the frozen
`operate_terminal` grant. Exact target, random/all selection and ordinary controls
retain their existing contracts. See [automatic assignment](orchestrator-routing-deep-dive.md).

The selected Brain returns an `interpret_workspace` plan. Invalid tool envelopes,
JSON or plans receive one repair attempt against the original context and strict
validator. Repeated failure cannot authorize effects. Current user instructions
and application-owned unfinished work supply authority; terminal output, assistant
replies, metadata and prerequisite findings are reference data. Private diagnostic
logs do not enter model context.

`operate_terminal` grants bind the complete objective and constraints to frozen
terminal IDs and generations. A delegated choice selects one eligible target once;
all-target requests retain their exact target set. The grant stays open across an
observe-act-verify loop, allowing task-relevant prompts and intermediate controls.
The executor reports a verified outcome with `finish_terminal`; saying “done” or
repeating the objective is not evidence that effects occurred. Finishing control
of a terminal does not itself establish completion of a delegated coding task.
For submitted tasks, the app formats finish receipts and replies from attributed
task evidence rather than accepting the model's status claims. Read-only task-status
questions bind their targets during semantic interpretation and use the same
evidence; output explanations and history summaries retain their normal read flow.
Completed task acknowledgements do not open listening merely because a model adds
an unsolicited follow-up in `respond`. Necessary clarification uses `ask_user`;
explicit voice dismissal and non-task conversational questions retain their controls.

Each effect requires a fresh, single-use `observationToken` from `read_session`
and a new `stepId`. Native controls also bind the observed screen sequence and
input revision. Read again after acting, including after an unchanged screen.
Generation, revision, recipient, input ownership and tool-shape checks are local;
the model interprets the screen and objective. Requests allow up to 24 grants,
128 operator steps per target and 32 operator model rounds. Legacy fixed-action
requests retain the 12-round loop. Context and spending limits still apply.

Exact/verbatim prompt requests use an operator with `promptMode: literal`,
which binds the complete user-supplied prompt without bypassing observation.
Legacy `send_prompt`, supplied-answer and navigation grants retain their bound
arguments and one-shot dispatch slots. Project creation binds its default parent
to Documents before execution. `stage_draft` requires an explicit draft request:
failed or unverified delivery never creates a draft automatically.

## Answers and permissions

Operator `answerMode: delegated` permits reasonable task-relevant answers when the
user delegates carrying out the objective. `supplied` requires the identified
user's answer text. Missing user knowledge still calls for clarification.
Structured answers validate the current interaction identity, revision and options;
custom and multiple-choice answers retain their provider-native mapping.

Permission authority is separate and defaults to none. Supplied decisions require
explicit user text; delegated permission decisions require explicit delegation for
this objective and cannot authorize persistent always-allow approval. A terminal
permission prompt cannot confer that authority. Native menu meaning and permission
classification remain semantic model decisions; local byte, identity and ownership
checks do not provide deterministic semantic approval enforcement.

## Terminal adapters

Working Codex root composers accept guarded pure followup prompts while output or
logical child work continues. Unsupported busy native composers can queue the
prompt until fresh readiness is observed. This does not relax general keyboard
controls, draft ownership, question/permission handling or recipient identity.
See [delivery and result attribution](orchestrator-tasks.md) for queue lifetime,
prewrite evidence and the distinction between a submitted followup and its result.

| Capability | Fusion / Open Fusion | Native terminals |
|---|---|---|
| Observe | Structured chat and current requests | Decoded terminal screen and input state |
| Deliver task | Structured input or supported steering | Observed composer through guarded native input |
| Answer | Structured question/permission APIs | Observed menus, keys, text and mouse |
| Verify | Native events and result evidence | Fresh screen plus separately attributed provider completion |

Native controls cover Claude, Codex, Cursor, Gemini, Kimi, custom Kimi, Qwen,
OpenCode and plain shells. Unknown startup state does not imply an unusable
composer: an operator can inspect and act without inventing an idle state. The
live root process and current observed identity must still pass transport checks.
Fusion/OpenFusion use their structured APIs rather than simulated keyboard events.

Named controls include navigation/editing keys, function keys, Ctrl/Alt shortcuts
and supported modified navigation. Raw escape bytes are not model input. Multiline
text and literal tabs require observed bracketed-paste mode. Mouse controls use
1-based terminal cell coordinates within the current dimensions and require the
application's SGR mouse reporting mode; drag motion requires the corresponding
tracking mode. Unsupported modes produce a recoverable refusal.

Input is request-owned. Current input revisions fence human edits and other
requests; pending typed text and mouse drags retain their owner across steps.
Manual input invalidates the previous owner. Editing/submitting existing human
input requires the authorized `editInput` path; unrelated requests cannot consume
another request's unfinished text or drag. A task submission through
`terminal_interact` identifies `inputPurpose: task`; menu answers use `interaction`.
Typing alone does not create a task-completion wait.

PTY receipts establish transport acceptance, not foreground consumption or task
success. Windows ConPTY provides no atomic foreground-recipient proof. Proven
pre-write blocks return `delivery: not-dispatched` and can be recovered after a
fresh read. Unknown writes retain uncertainty and cannot be replayed. A per-source
operator ledger preserves prior step receipts, budgets and uncertain submissions
through clarification/continuation; minting a continuation does not reset them.

Saved-history resumption retains its separate exact-identity contract. External
applications, clipboard access and global keyboard injection are outside these
terminal controls.

### Inspecting native state and usage

Requests such as “How much Codex usage do I have left?” or “Check Claude's usage
limits” use `responseKind: terminal-inspection`. The interpreter grants scoped
`operate_terminal` navigation on the identified native terminal when information
must be revealed through its controls. Questions about existing output, history,
or a tracked task's progress still use passive reads. Inspection may also use
reads alone when the information is already visible or the pane is structured.

Application-owned `terminalNavigationGuide` hints accompany fresh `read_session`
results. Model directories omit repeated guides to preserve context; full session
summaries can still include them. Codex starts with `/status` for configuration, token
usage and available rate-limit windows. Its `/usage` menu can include browser and
usage-reset actions, so it is not the default inspection path. Claude Code uses
`/usage` for available plan limits/cost, `/status` for session configuration, and
`/context` for context usage. These are version-dependent hints: the current
screen and help determine available commands and menu navigation. Claude's
[official command reference](https://code.claude.com/docs/en/commands) documents
the commands; Codex behavior is grounded in the vendored CLI's slash dispatch and
status-command tests. Explicit guides also cover Cursor, Gemini, OpenCode, Kimi,
custom Kimi, Qwen and Grok Build, with their own help, status, usage and menu
controls. See the [provider navigation reference](orchestrator-terminal-navigation.md)
for commands, data meanings and source evidence. Plain shells and Fusion/OpenFusion
do not inherit another CLI's slash commands.

Inspection grants preserve the agent and existing input. Local validation excludes
task submission, permission answers, interruption, editing existing input, and
non-navigation effects; the model must restrict native commands and menu choices
to the informational objective. A usage request does not authorize changing
settings, signing in, buying credits or spending a reset. Busy composers, drafts,
stale observations and uncertain writes retain the normal input guards. Read the
result after navigation and report displayed values, distinguishing used from
remaining, plan limits from context fullness, and each window/reset time. Missing
data or a blocked terminal requires a concrete explanation before an external
account-page fallback. The factual result survives completion formatting and
voice output instead of becoming `done`; blocked continuations retain inspection
scope.

## Files and verification

- `backend/orchestratorIntent.cjs`: immutable objectives, delegation, frozen targets
  and per-source step/dispatch accounting.
- `backend/orchestrator.cjs`: observation tokens, model loop, recovery, receipts and
  verified scope completion.
- `backend/orchestratorTerminalInput.cjs`, `backend/ptyHost.cjs`,
  `shared/terminalControls.cjs`: native input, modes, ownership and acknowledgments.
- `backend/orchestratorIntegration.cjs`, `backend/terminalObservation.cjs`:
  structured/native adapters and current screen/input evidence.
- `backend/orchestratorTerminalGuide.cjs`: provider-specific inspection hints and
  the native observation/navigation/reporting policy.

`npm run test:orchestrator` covers semantic compiler/executor fixtures, grants,
provider bridges, native controls, task dependencies, history, diagnostics and
voice lifecycle. Scripted responses verify protocol behavior rather than model
judgment. The configured Brain passed four of four live disposable-adapter cases;
those checks sent no actions to the user's terminals.

The terminal-inspection regression suites cover Codex, Claude/custom Claude,
native tabs and Escape, factual text/voice responses, unavailable quota, passive
reads, stale observations, forbidden task input, and continuation scope.
`node scripts/qa/orchestrator-terminal-inspection-live.cjs` checks the configured
Brain and default interpreter with disposable synthetic terminals and a $0.25
per-run spending ceiling. `--self-test` checks only the fixture, without network
or credentials. These checks verify command selection and orchestration, not the
installed vendors' physical menu rendering.

`node scripts/qa/orchestrator-command-smoke.cjs --hidden` exercises isolated
Electron/preload/PTY paths without a visible test window. Native helper fixtures
and real hidden PTY smoke checks do not establish every installed CLI's physical
menu behavior. Hidden mode skips screenshots, foreground/clipboard checks and
microphone/overlay activation; those remain separate acceptance boundaries.
