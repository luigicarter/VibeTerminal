# Orchestrator and terminal controls

## Conversation and recovery

Vibe's response contract calls for a warm, direct voice, brief useful replies, and
no parroting of the request. Voice history listings offer at most three relevant
choices unless the user asks for more. Direct actions use named, factual outcomes
instead of raw labels such as “Action written”; drafts, queues, accepted input,
requested interruption and observed completion remain distinct.

Spoken replies retain the exact request they follow, including its question and
bounded exchange context when unrelated work has moved it outside recent history.
This context helps resolve follow-ups; it does not revive completed grants or turn
assistant suggestions into authority. Topic changes remain new instructions.
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

## Files and verification

- `backend/orchestratorIntent.cjs`: immutable objectives, delegation, frozen targets
  and per-source step/dispatch accounting.
- `backend/orchestrator.cjs`: observation tokens, model loop, recovery, receipts and
  verified scope completion.
- `backend/orchestratorTerminalInput.cjs`, `backend/ptyHost.cjs`,
  `shared/terminalControls.cjs`: native input, modes, ownership and acknowledgments.
- `backend/orchestratorIntegration.cjs`, `backend/terminalObservation.cjs`:
  structured/native adapters and current screen/input evidence.

`npm run test:orchestrator` covers semantic compiler/executor fixtures, grants,
provider bridges, native controls, task dependencies, history, diagnostics and
voice lifecycle. Scripted responses verify protocol behavior rather than model
judgment. The configured Brain passed four of four live disposable-adapter cases;
those checks sent no actions to the user's terminals.

`node scripts/qa/orchestrator-command-smoke.cjs --hidden` exercises isolated
Electron/preload/PTY paths without a visible test window. Native helper fixtures
and real hidden PTY smoke checks do not establish every installed CLI's physical
menu behavior. Hidden mode skips screenshots, foreground/clipboard checks and
microphone/overlay activation; those remain separate acceptance boundaries.
