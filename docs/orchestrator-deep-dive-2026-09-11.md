# Orchestrator deep dive and failure audit

September 11, 2026. A capability inventory of the Orchestrator plus a ranked list
of the failures the user actually hit between September 7 and September 11,
reconciled against the installed build, the saved profile and the source tree.
The wrong-recipient failure of September 11 was reproduced live and repaired.

Private transcript contents, credentials and identifiers are not reproduced.

## Evidence used

| Source | What it holds |
| --- | --- |
| `%APPDATA%\vibe-terminal\orchestrator-conversation.json` | 326 messages (122 user, 98 assistant, 106 system), 217 action receipts, 122 task records, September 7–11. |
| `%APPDATA%\vibe-terminal\orchestrator-work-items.json` | 11 work items: 7 finished, 1 cancelled, 3 failed. |
| `%APPDATA%\vibe-terminal\orchestrator-agents-v1.json` | 20 saved agent identities. |
| `%APPDATA%\vibe-terminal\logs\orchestrator-errors.jsonl` (+ `.1`, `.2`) | 13,921 diagnostic records, of which 13,803 are voice-inference stream telemetry. Only September 10–11 survive rotation. |
| `apps/desktop/.tmp/orchestrator-routing-live/*` | Three live probe reports: one reproduction, one pass, one new failure found today. |
| Installed build | 0.1.116 (`%LOCALAPPDATA%\Programs\vibeTerminal`), published 13:51 Toronto on September 11. |

Usage per day in the saved conversation: 95, 98, 111, 17, 5 messages from
September 7 through 11. Nine releases (0.1.108–0.1.116) shipped between
September 9 and 11, so most September 7–9 failures ran on older builds.

## What the Orchestrator is

A voice/text command relay over a planner model reached through OpenRouter. One
request passes through these stages (`apps/desktop/backend/orchestrator.cjs`):

1. **Input** - push-to-talk or verified wake phrase (`voiceWakeVerifier.cjs`),
   Whisper transcription, or typed text. Wake-path text has the `hey lina`
   prefix stripped; push-to-talk text is passed through unchanged.
2. **Interpretation** (`orchestratorInterpreter.cjs`, `orchestratorPlannerTools.cjs`) -
   the planner model must answer with one or more `plan_*` operation calls:
   one `plan_<kind>` per intent kind in `orchestratorIntent.cjs`:
   `delegate_task` (plus `plan_continue_task` for an existing owner),
   `operate_terminal`, `inspect_terminal`, `create_session` (offered as
   `plan_open_blank_terminal` and `plan_prepare_terminal_draft`), `stage_draft`,
   `send_prompt`, `terminal_interact`, `answer_question`, `permission`,
   `interrupt`, `restart`, `close`, `focus_session`, `watch_terminal`,
   `navigate`, `add_project`, `remove_project`, `open_folder`, `create_project`,
   `launch_setup`, `save_setup`, `resume_conversation`, `remember_preference`,
   `forget_preference`; plus `plan_conversation` for plain answers and
   `interpret_workspace` for metadata or clarification. `normalizeIntent`
   validates the plan; a contract or review failure gets one repair round and
   then collapses to the generic message "I could not interpret that request."
3. **Assignment** (`prepareTaskAssignments`, `orchestratorRoutePlanner.cjs`) -
   for delegated work a routing model discovers the owner with
   `find_agents`, `read_agent`, `read_work_item`, `list_sessions`,
   `read_session`, `list_work_items`, `list_conversations`,
   `read_conversation`, then proposes `choose` (reuse / create / clarify) within
   8 rounds. A proposed reuse is then judged by the task-affinity reviewer
   (`orchestratorTaskAffinity.cjs`), a second model call that must return JSON
   with quotations from the user's instruction and the observed task text.
4. **Execution** (`executeRequest`, `orchestratorWorkspaceExecutor.cjs`,
   `orchestratorToolSchema.cjs`) - the executor model drives scoped workspace
   tools: reads (`read_file`, `read_workspace`, `list_roots`, `list_sessions`,
   `read_session`, `search_files`, `list_setups`, `read_setup`,
   `list_preferences`, `list_work`, conversation history) and grant-scoped
   effects (`send_prompt`, `terminal_interact`, `answer_question`,
   `permission`, `interrupt`, `focus_session`, `finish_terminal`, `stage_draft`,
   `close`, `restart`, `create_session`, project and setup operations,
   `ask_user`, `respond`). Every terminal effect requires a fresh observation
   token from a prior read of that terminal.
5. **Delivery and verification** (`orchestratorDelivery.cjs`,
   `orchestratorTerminalInput.cjs`, `orchestratorPromptReadiness.cjs`) - a prompt
   is written to the PTY only when the native composer is observed ready and the
   screen sequence and input revision still match the last read. Startup
   readiness waits up to 20 seconds; delivery confirmation waits 15 seconds;
   completion is reported as unverified when the agent is not seen starting.
6. **Reviewers** - three more JSON-answering model calls guard specific
   decisions: close safety (`orchestratorCloseSafety.cjs`), goal review
   (`orchestratorGoalReview.cjs`) and target review
   (`orchestratorTargetReview.cjs`).

Hard limits: 45-second model deadline per call (`orchestratorModelRuntime.cjs`),
8 routing rounds, a 48,000-byte application ceiling on model input
(`orchestratorBudget.cjs`), 20-second workspace acknowledgment
(`orchestratorIntegration.cjs`), optional session spending limit.

## Failure classes, ranked by what the user hit

Receipts for terminal effects: 33 `terminal_interact` written versus 38
rejected; 31 `send_prompt` written versus 20 rejected, 3 stale-observation and
1 launch-timeout. Tasks: 73 finished, 27 paused, 20 cancelled, 2 failed.

### 1. "Continue" sent to a new terminal instead of the existing agent (September 11)

The user asked the agent already working on the project chat section to
continue. Diagnostics show the router found that agent and chose reuse, then
the application reserved `create` and opened a new Codex pane. The user closed
it as the wrong recipient.

Three separate causes, all on the installed 0.1.116:

- `plan_continue_task` decoded to ordinary automatic assignment, so the
  requirement to use the existing owner was lost before routing.
- A non-`same-task` affinity verdict was converted into a fresh agent instead
  of a clarification.
- **Found today:** the affinity reviewer's reply was wrapped in a Markdown code
  fence. `decision()` called `JSON.parse` directly, threw, and returned
  `unclear`. The same bare `JSON.parse` existed in the close-safety, goal-review
  and target-review parsers. Live probe `1789151921854-39224` received bare JSON
  and passed; probe `1789153108265-51656`, run today with the same
  `google/gemini-3.8-flash`, received fenced JSON and produced "I could not
  verify that this agent owns the task" with no prompt sent. Every other model
  step in both runs was identical and correct.

Status: the first two causes are repaired in uncommitted source
(`docs/orchestrator-continuation-errors-2026-09-11.md`). The third is repaired
today (see below). Nothing is in the installed build yet.

### 2. Prompt written but the agent never started (September 8–9)

Five system replies said input was sent but startup was unconfirmed; the user
replied several times that the prompt had not been pasted. Receipts show the
mechanism: 17 rejections for "the terminal changed after the last observation"
and 4 for a missing or stale observation token, one launch timeout because the
native composer was not ready within 20 seconds, and `finish_terminal` blocked
because a busy Codex pane redraws its timer every second so the screen sequence
never holds still. Startup-queued prompts stay `paused` (27 task records).

Status: the September 8 queue investigation and 0.1.109–0.1.114 repaired the
verified-unsent retry and busy-queue paths. The sequence-fence design still
cannot deliver into a pane whose TUI is animating, so busy Codex panes remain a
known limit rather than a bug with a pending fix.

### 3. "I could not interpret that request" (seven times, September 7–10)

This message replaces every interpretation failure after one repair round
(`orchestratorInterpreter.cjs:217`). It appeared for a request to change voice
behaviour, for "what was that error?", for resume-by-name requests and for a
plain Codex delegation. The real reason lives only in the private diagnostics,
and those had already rotated for six of the seven cases.

Status: open. Two aggravating factors: the configured planner from September 7
until 14:17 on September 11 was `inception/mercury-2.5`, which the September 10
capability audit already found unreliable for answers; and the diagnostics log
retains about one day (class 7).

### 4. Application context ceiling blamed on the model (three consecutive requests, September 9)

`modelInputBudget` caps model input at 48,000 bytes regardless of the model's
context window. When receipts plus a large terminal page exceeded it, three
requests in a row failed with a message telling the user to pick a model with
a larger context window, which would not have helped.

Status: open. The cap is deliberate, but the trimming should drop older
receipts or page the read, and the message should not blame the model.

### 5. OpenRouter timeouts on trivial requests (three, September 8–9)

"Open a new Codex terminal" timed out at the 45-second deadline twice on
September 9 and once on September 8.

Status: the forced tool-choice incompatibility was repaired in 0.1.113
(September 10). No timeout appears after that release.

### 6. Routing discovery exhausted (once, September 9)

Eight rounds without a choice ends with "no terminal was assigned". This is a
bound working as designed; the stagnation nudge after two empty rounds exists.

### 7. Diagnostics log is unusable for error hunting

`voiceController.cjs:151` records a `voice_inference` stream event for every
audio frame while hands-free is on. That is 99 percent of the file, it rotates
at 1 MB roughly daily, and everything before September 10 is gone. Earlier
investigations already noted the retention gap; this is the cause.

Status: open. Route voice timing to its own file or sample it.

### 8. Wake-phrase text leaks into instructions

`voiceWakeVerifier.cjs` accepts LINA, LENA, HE LENA and HELINA pronunciations,
but `voiceController.cjs:456` strips only a literal `hey lina`, and only on the
wake path. Saved requests begin with "Hey Alina", "Hey Lena", "Hey Elena",
"Hey, bye" and "Here, Lina". That noise reaches the planner, the router's
`currentInstruction` and the affinity quotations.

Status: open.

### 9. Naming that confuses the user

Open Codex and Codex Web panes are identified by the shell path
`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe` in spoken and written
replies (`orchestratorAgents.cjs:88` falls back to the session name). Work-item
titles are cut mid-sentence ("Investigate and fix the issue where") and then
used as terminal names in replies.

Status: open, cosmetic but repeated in every status message.

### 10. Inactive-terminal closure (September 10)

The user asked to clear non-working terminals; the assistant listed five,
miscounted, and after correction closed three. Covered by
`docs/orchestrator-inactive-close-investigation-2026-09-10.md`; guards shipped
in 0.1.114.

## Repair made today: fence-tolerant reviewer JSON

`parseModelJson` in `orchestratorModelRuntime.cjs` strips one enclosing
Markdown code fence and otherwise behaves exactly like `JSON.parse`. It replaces
the bare parse in `orchestratorTaskAffinity.cjs`, `orchestratorCloseSafety.cjs`,
`orchestratorGoalReview.cjs` and `orchestratorTargetReview.cjs`. Non-JSON
replies still fail closed as before.

Verification is recorded in the section below after the independent audit.

## Verification

Independent audit of the parser change, run separately from the author:

- Changed files are exactly the four reviewers, `orchestratorModelRuntime.cjs`
  and their five test files; nothing else in the tree moved.
- Focused reviewer tests: 36 before, 42 after, all passing. Each reviewer now
  has a case proving a fenced reply is judged like the bare JSON it wraps and
  a fenced non-JSON body still fails closed.
- `npm run test:orchestrator`: 29 performance checks and 2,092 backend tests
  passed, 0 failed.
- No bare `JSON.parse(choice?.message?.content)` remains in `backend/`.
- `node scripts/qa/orchestrator-routing-live.cjs --existing-owner` with the
  configured `google/gemini-3.8-flash`, run twice after the change (reports
  `1789153577637-55172` and `1789153625604-3628`): both sent exactly one prompt
  to the existing chat-section owner and created nothing. The second run
  received the fenced reviewer reply, the same shape that failed in
  `1789153108265-51656` before the change. Cost per run was under two cents.

Limits: the probe uses disposable in-memory terminals, not the installed
native panes. The affinity, routing and planning decisions are still model
judgments; the repair removes a deterministic parsing failure and the
application no longer creates a replacement terminal when those judgments are
uncertain, but an uncertain judgment now ends in a clarification question
rather than the prompt being delivered.

## Measurements after the de-serialization work (same day)

| Request class | Before (September 11 morning) | After |
| --- | --- | --- |
| Continue a named existing agent, no work item | 6 model calls, about 34 seconds | 1 model call, about 2 seconds |

Measured with `scripts/qa/orchestrator-routing-live.cjs --existing-owner`
against `google/gemini-3.8-flash`; the probe now fails above 3 calls. Details
in [the de-serialization plan](orchestrator-deserialization-plan-2026-09-11.md).

## What reaches the installed app

Nothing above is installed. The working tree also carries unrelated uncommitted
work (Codex Web and Open Codex changes, removal of the in-app version switcher,
release workflow changes). Shipping the continuation repairs means committing
that batch and publishing 0.1.117 through the Windows release workflow.

## Recommendations, in order

1. Release the continuation repairs plus today's parser fix as 0.1.117.
2. Keep `google/gemini-3.8-flash` or stronger as the planner; do not return to
   Mercury 2.5 for the brain.
3. Move voice-inference timing out of `orchestrator-errors.jsonl`.
4. Replace the generic interpretation failure with the validator's own reason
   when it is a contract error, and answer "what was that error?" from the
   last receipt.
5. Strip every accepted wake pronunciation on both input paths.
6. Trim receipts before failing on the 48,000-byte ceiling, and reword the
   error.
7. Name Open Codex and Codex Web agents by their conversation title, and cut
   work-item titles at a word boundary with an ellipsis.
