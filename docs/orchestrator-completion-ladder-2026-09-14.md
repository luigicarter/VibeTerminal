# Orchestrator completion ladder (2026-09-14)

The question this answers: given the sentences the user actually says to Lina, from the easy ones ("open a Codex terminal in vibeTerminal") to the vague ones ("prompt the other one as well", "close the three that are inactive"), does the Orchestrator finish them, and how small a Brain model can finish them?

Until today the Orchestrator was tested one mechanism at a time (fences, resolver rules, readiness recognizers) against fixtures. Nothing ran a user's own request through the real app, into a real provider pane, with the real Brain, and graded whether the request was *completed*. The ladder does that, and its first two runs found seven defects in the app that the mechanism tests could not see, because each of them lives between mechanisms.

## What runs

`npm run smoke:orchestrator:ladder -- --tiers 1-4 --budget 2`

- **The app is real.** `scripts/qa/lib/app-harness.cjs` launches the packaged-equivalent Electron app on a scratch profile (userData, HOME, both CLI homes, the agent shim directory all inside `%LOCALAPPDATA%\lina-terminal-harness\<run>`), drives it over CDP the way `scripts/qa/*-smoke.cjs` do, and reads back every record the app writes: state, receipts, the action ledger, memory, the diagnostics log.
- **The panes are real.** Codex 0.154 and Claude Code 2.1.270 run in real PTY panes through the app's own launchers, hooks and readiness recognizers. Their model calls go to `scripts/qa/lib/stub-model-server.cjs`, which speaks the Responses, chat-completions and Anthropic SSE wire formats and follows tags in the prompt: `[stub:reply:MARK]` finishes at once and prints MARK, `[stub:slow:N]` holds the turn open N seconds, `[stub:ask]` calls the provider's question tool so the pane parks on a real question. Only codex and claude may launch; gemini, qwen, kimi, grok, cursor and opencode write the user's real CLI homes and stay off the harness PATH.
- **The Brain is real.** The installed OpenRouter key is copied encrypted (with its `os_crypt` section) and decrypted by the app's own `safeStorage`; it is never printed or logged. `--local-brain <url>` points the relay at an OpenAI-compatible server on this machine instead (`LINA_ORCHESTRATOR_API_BASE`), which is how a local Qwen is measured. The bill is the Brain's interpretation and reply calls only, capped by the app's own spending limit and re-checked after every turn.
- **The corpus is the user's.** `scripts/backend/fixtures/orchestrator-completion-ladder.json` holds 26 scenarios, 54 turns, every turn a row of the 128 saved utterances (`row`) or, for a handful, a sentence shaped like one (`synthetic`). Each scenario declares the workspace it needs (projects, panes and their state: idle, working, done with a marker, or parked on a question) and each turn declares what completion means: task status, which pane got the prompt, pane delta, what the reply must mention, what must not happen.

| tier | scenarios | turns | what it measures |
| --- | --- | --- | --- |
| 1 | 6 | 6 | open, start, report, noise |
| 2 | 5 | 6 | reuse an idle pane rather than open one; never type into the busy one |
| 3 | 5 | 9 | "the terminal you just opened", follow-ups to a busy pane, truthful answers about what was typed, never mind, answer-plus-new-work |
| 4 | 1 | 14 | one workspace of three projects and six panes; tracking who is working, who needs the user, who is done, across fourteen consecutive vague turns |
| 5 | 3 | 12 | native navigation: usage, model, effort, compact, clear, help, in Codex and Claude panes |
| 6 | 6 | 7 | one sentence that opens and prompts, a sentence that corrects itself, a complaint, a question about Lina, two panes for one prompt, a three-project sweep |

`scripts/qa/lib/ladder-grader.cjs` grades a turn from the app's records only: the task's settled status, receipts, ledger rows, the pane inventory before and after, and the pane screens it read. A verdict is `pass`, `question` (the turn allows a clarification and one was asked) or `fail`; `harmful` counts separately (a pane opened or closed, or a prompt typed, where the turn forbids it). The scoreboard lands in `apps/desktop/.tmp/orchestrator-ladder/<run>/scoreboard.md` beside every model call's request and response (`model-calls/`, key-shaped strings redacted by the runtime).

## Results on the configured Brain (openai/gpt-5.6-luna)

| run | tiers | pass | question | fail | harmful | cost |
| --- | --- | --- | --- | --- | --- | --- |
| first run (before any fix) | 1–4 | 4 | 0 | 31 | — | $0.11 |
| after fix round 1 (fences, target review, inventory wait) | 1–4 | 11 | 2 | 22 | 4 | $0.11 |
| after fix round 2 (findings 1–7) | 1–4 | 19 | 1 | 13 | 2 | $0.13 |
| after fix round 3 (findings 8–9, relay seeding) | 1–4 | 23 | 3 | 9 | 0 | $0.08 |
| after fix round 4 (stale sources, inspection answers, naming) | 1–4 | 25 | 2 | 8 | 1 | $0.09 |
| after fix round 5 (supplied answers, numbering) | 1–4 | 26 | 3 | 6 | 0 | $0.06 |
| after fix round 6 (prompt length, reply ranking, mouse move) | 1–4 | 28 | 2 | 5 | 1 | $0.06 |
| after fix round 7 (workspace lane, idle before continue, deadline) | 1–4 | 30 | 2 | 3 | 0 | $0.04 |
| after fix round 8 (scoped lane, stop vs close descriptions) | 1–4 | 30 | 2 | 3 | 0 | $0.08 |
| round 9 (by-pane memory, stop coercion) — run under full load, see below | 1–4 | 26 | 1 | 8 | 1 | $0.11 |
| after fix round 10 (clock-skew tolerance, startup retry) — quiet machine | 1–4 | 30 | 1 | 4 | 2 | $0.09 |
| after fix round 11 ("the other one" decided by the review) | 1–4 | 31 | 2 | 2 | 0 | $0.07 |
| after fix round 12 ("tell it" continuation) | 1–4 | 31 | 1 | 3 | 1 | $0.10 |
| after fix round 13 ("the other one" asks unless anchored by the latest delivery) | 1–4 | 33 | 2 | 0 | 0 | $0.05 |
| round 14 (first result gate only; two turns flaked back) | 1–4 | 30 | 2 | 3 | 0 | $0.05 |
| round 15 (three result gates; the fourth still closed) | 1–4 | 30 | 2 | 3 | 0 | $0.05 |
| after fix round 16 (all four result gates; results answered from memory) | 1–4 | 32 | 0 | 3 | 2 | $0.05 |
| round 17 (same tree, alone on the machine) | 1–4 | 33 | 1 | 1 | 0 | $0.04 |
| after fix round 18 ("tell it" continuation runs beside the project's work) | 1–4 | 32 | 1 | 2 | 0 | $0.05 |
| overhaul phase 1 (the terminal model; handles in every answer) | 1–4 | 31 | 1 | 3 | 0 | $0.07 |
| overhaul phase 2 (one reference resolver), before its T4.1 fix | 1–4 | 28 | 1 | 6 | 2 | $0.05 |
| overhaul phase 3 (handles to the Brain), with the phase-2 fix; 0.97 calls/turn, 4.35 s to first effect | 1–4 | 32 | 1 | 2 | 0 | $0.04 |
| overhaul phase 4 (compiler over handles: stop, close, follow-up); 0.89 calls/turn, 3.66 s to first effect | 1–4 | 32 | 1 | 2 | 0 | $0.03 |
| overhaul phase 5 (fan-out delivered in code; T4.9 one call, 6 s); the Brain's `literal` label killed T3.3a and "it" then fell to the spare pane | 1–4 | 32 | 1 | 2 | 1 | $0.03 |
| overhaul phase 6 (a task owns its pane, not the worktree; literal label corrected at decode; "it" asks when nothing is on record) | 1–4 | 34 | 1 | 0 | 0 | $0.07 |

The phase-1 run (2026-09-15T17:19, alone on the machine) lost T1.4 to its own naming: the progress report read "T4 is working; T5 is idle" and the corpus wants the word terminal, so the report now names each pane as "T4 (Codex terminal) is working on “…”". T3.3a and T3.3b were delivered into the right working pane and settled `running` at the 20-second settle: 13.5 s in the interpretation call, then a five-call operator loop to 21.5 s. That is the call count phase 5 of the overhaul removes, not a resolution fault. T4.7 asked, which the corpus allows. The phase-2 run (2026-09-15T17:52) lost five tier-4 turns and two of them harmfully to one merged rule: T4.1's "have a agent working on adding a chat section" went into the spare pane because the unified resolver applied the review's no-sole-candidate reading (the sentence says "a agent") to assignment as well, and the spare then stood in for the chat-section pane in T4.3, T4.8, T4.11 and T4.12. Fixed the same evening (the resolver reports the allowance for assignment and withholds it from the review); the phase-3 run below carries the fix. See `docs/orchestrator-terminal-model-overhaul-2026-09-15.md` section 9 for the phases and their runs.

A `question` is a turn that allows a clarification and got one. On the fifth run the six failures were: a Codex pane that showed the typed prompt as "[Pasted Content 1257 chars]" and never submitted it (finding 11); a hand-started pane that cannot be named by its task (T4.2, see Open); "tell it to continue" to a pane parked on a Codex question, where the Brain spent fifteen calls trying keys against an animating question form (T4.5); a fan-out whose delivery succeeded but whose push the Brain would not certify from a stub reply (T4.9, now graded on delivery); and two turns that queued behind a workspace acknowledgment that timed out (T4.11, T4.12, finding 12). Model calls fell from 2.74 to 1.63 per turn and the bill from $0.11 to $0.06 over the same 35 turns.

The sixth run cleared the paste and the push, and left the two queued turns (finding 13), the two memory answers (finding 15), "tell it to continue" and "prompt the other one as well" (see Open). The seventh run, with the lane and the continue rule changed, is the first on which every tier 1–3 sentence completes, and its three failures are the two memory answers, which were changed after the run started, and "stop that last terminal you worked on", which Luna planned as a close of three panes that turn (the close reviewer refused and asked); the planner tool descriptions now say that "stop", "interrupt" and "pause" keep the pane and are an `operate_terminal` interrupt, and that `close` is for close, quit and kill. Model calls were 1.3 per turn and the bill $0.04.

Run eight repeated run seven's score with a different pair of failures ("stop that last terminal" typed "Stop this terminal." into the wrong pane, finding 16; the memory answers still by label, the key bug in finding 16). Run nine, the first with both fixed, went *backwards* to 26, and every new failure is timing: it ran while the cheap-model ladder and the full test gate loaded the same machine, and the first prompt into a freshly opened pane was refused with "evidence is required (age:-1)" (the observation stamped in the main process read one millisecond younger than the host's clock) and "changed while I was about to type" (one more composer repaint after readiness, which a startup send was not allowed to retry). Each refusal then cascaded: 29 model calls on the first, a stale reservation that made the next idle-pane request "owned by other work", and a wrong "other one". The host now tolerates a second of clock skew, and a startup send retries after readiness like any other send. "Which one needs me" did answer with the task on run nine ("Codex terminal 2 in lina web app, on “Do a deep dive on the PDF viewer”, is waiting on you").

## What the ladder found in the app

Each of these was a request the user had actually made, settled wrong, with the cause read from the app's own records and confirmed by a probe against the real app before it was changed.

### 1. A pane nobody had prompted yet was never "idle"

Every request for "one of the empty terminals" answered "No idle Codex pane is free. Open a new one?" while two empty Codex panes sat in the project (T2.1, T2.2, T2.3, T3.2, T4.11). The Brain's own pick was refused too: "No selected terminal is currently free."

The app publishes a fresh pane's turn as `unknown`, not `idle` (measured on a fresh Codex and a fresh Claude pane: `status: "unknown", turnState: "unknown"` ten seconds after launch and still so minutes later). The one pane-state predicate treated an unrecognized turn state as neither idle nor busy, so idle-target selection and idle-pane reuse both refused the pane, and the resolver opened another one beside it. That is the "it opened new terminals even though I had empty terminals" the user reported on 2026-09-13.

`backend/orchestratorPaneReadiness.cjs` now reports a fifth fact, `untouched`: the pane has never taken a turn and reports nothing busy or waiting. Choosing a pane for new work (`isIdleTarget`, `idlePaneCandidate`) reads `idle || untouched`; delivery classification and launch readiness keep reading `idle`, so a pane whose turn is unknown still gets its first prompt through the screen-verified startup path and is still `process-ready` rather than `ready` at launch. A pane that has taken a turn and reports an unrecognized state stays not free.

### 2. A task in a Claude pane never finished

"Open a Claude Code terminal and have it fix the full screen bug" typed the prompt, Claude answered on screen within a second, and the task sat in `waiting-results` until the harness gave up 242 seconds later; the ledger said `delivered-unconfirmed` (T1.3, T3.5, T4.9). The first attribution, that Claude's hooks were not reaching the app, was wrong: a probe showed the pane going `unknown → running → response` within a second of the write.

Two facts combined. Claude's hooks carry a session id but no turn id, and the runtime left `turnId` undefined for a turn that starts without one; the task scheduler attributes a typed prompt to the turn it started by that id, so the wait could never bind. And Claude's completion capability is `coarse`: its Stop hook ends the turn as a provisional `response`, never `completed`, and the scheduler only settled a wait on `completed`. The same holds for every coarse provider (Gemini, Kimi, Qwen, Cursor, OpenCode, Grok): no task typed into those panes by the Orchestrator ever reported finished.

`backend/terminalRuntime.cjs` now names a turn that starts without a provider id by the pane's generation and the moment it began, so attribution works the same way it does for Codex; `backend/orchestratorTasks.cjs`, `orchestratorTaskStatus.cjs` and `orchestratorTaskReports.cjs` treat a root `response` with no child activity as the turn's end. The work history (`orchestratorWork.cjs`) still records only observed completions, as its tests pin. The same scenario now settles as `finished` with `delivered-started` in 4 seconds.

### 3. A Codex question was invisible

"There's a terminal that needs me. Which one is it?" answered "Nothing is waiting on you right now" while a Codex pane sat on a `request_user_input` question (T4.2). Codex reports that tool through its ordinary `PreToolUse` hook, which the app's hook observer mapped to "working". `backend/agentTelemetry.cjs` maps a `PreToolUse` whose `tool_name` is `request_user_input` to `agent.waiting` with reason `question`; a probe shows the pane reading `waiting` with a question attention 2.6 seconds after the prompt. The memory fast path also stops saying "nothing is waiting" while any pane is still working, and lets the Brain read the panes instead.

### 4. Every earlier unanswered question reached every later Brain call

By tier 4 the Brain's request context carried eight pending commands from earlier scenarios, six kilobytes of them, and it kept "continuing" one of them (`plan_continue_task` with a foreign `sourceUserId`) for sentences that were new work, which the continuation contract rightly refused and the request died as "I could not interpret that request" (T2.4b, T3.3a, T4.12). In the app, a question Lina asked and the user never answered stays a pending command through "clear history" by design (`orchestrator-continuation-history-integration.test.cjs` pins that a clarification chain survives a clear). The harness now cancels every request between scenarios, as scenarios are independent. The product behaviour is unchanged and noted as open below.

### 5. An invented observation token cost 32 model calls

"What did the full screen bug terminal say?" spent nine rejected `focus_session`/`finish_terminal` calls on tokens the Brain made up (`obs-session_…`, `96`) and failed at the relay's action limit (T4.4). A token the operator never minted is now treated as absent, so the action binds to the Brain's latest unused read of that pane exactly as an omitted token does; a token that was minted is still checked as before (used, stale, wrong pane). The tool description tells the Brain to omit the field. `scripts/backend/orchestrator-operator.test.cjs` pins both halves.

### 6. A Brain that answered in prose ended the request

"No, close the three that are inactive" got, twice, a sentence from the Brain: "I can't reliably identify which three inactive terminals you mean; the project has five." The interpreter required a tool call and reported "The Brain did not return a valid command interpretation" (T4.14). Prose with no tool call is now a clarification the user can answer: one call, no retry, no effect.

### 7. Panes described by what they are doing had no selector

"Let the Codex terminal that's currently working know…", "on both terminals that are currently done", "stop that last terminal you worked on", "prompt the other one as well" all reached the Brain with no deterministic reading (T3.3, T4.7, T4.8, T4.9). `backend/orchestratorResolver.cjs` reads four more selector kinds from the sentence, `working`, `done`, `last_target` and `other`, each resolved by a rule of its own from the roster or the action history (one match reuses, several ask by name, none asks), and `backend/orchestratorTargetReview.cjs` confirms a plan that names the one working pane or every done pane (`state-matching`), keeps the named panes when a fan-out cannot be confirmed, and never rewrites a stop into a task. The last-target phrase moved out of the intent normalizer into the resolver so the two read the same words.

### 8. A read the Brain paged from the start minted no token

Every operator flow on the second run looped the same way: `read_session`, `finish_terminal`, "Read this terminal again before acting; the observation token is missing, used, or stale", `read_session`, until the relay's action limit (T3.1b and T3.3a took 33 calls each, T4.5 twenty). The Brain always reads with `beforeSequence: 1`. The app treats any `beforeSequence` as a page of retained display samples, and a page mints no observation token; with nothing before the first sample the page was also empty. A read that pages from 1, or past the start of the samples, is now the current screen: it returns the screen and mints the token every later step binds to.

### 9. A Brain that answered in prose was asked a question back

Finding 6 turned prose into a clarification; "No problem." and "Correct, it's three" then reached the user as questions and left the request in `needs-answer` (T3.4, T4.4, T4.13). Prose that asks something (a trailing question mark, "which one", "should I", "please specify") is a clarification; prose that tells the user something is the reply, published as it stands with no execution round and no effect (`plan.reply`).

### 10. A long prompt sat unsent in a Codex composer

"Use the Codex terminal that's not doing anything" resolved to the free pane, the host reported the write accepted, and the task waited four minutes for a turn that never started. The pane's screen, captured by the harness, showed `› [Pasted Content 1257 chars]` at the composer: Codex reads a long write as a paste and keeps consuming it past the host's fixed 200 ms gap, so the Enter staged after the text is swallowed into the paste and the prompt stays in the composer. The gap now grows with the text (half a millisecond per character past the first four hundred, at most a second and a half); short prompts keep the 200 ms the host's tests pin.

### 11. Fifteen tries reported the last race instead of the pane's need

"Tell it to continue" to a pane parked on a Codex question ended with "I couldn't do that in …: Read the current terminal screen before interacting." The one receipt that said what mattered, the prompt refused because the pane "is waiting on an answer before it can continue", was in the middle. The final reply keeps one failure sentence per pane and now lets a reason about the pane outrank a reason about an attempt, so the user hears what the pane needs.

### 12. A local Brain was refused before it was asked

The first local run (Qwen3.5-2B through Ollama, `LINA_ORCHESTRATOR_API_BASE=http://127.0.0.1:11434/v1`) scored 4 of 21 with zero model calls: 17 turns settled as failed with "Local context limit: this request needs 21,735 UTF-8 bytes …; Lina's input budget is 14,160". Ollama's OpenAI-compatible `/v1/models` states no `context_length`, and the budget (`orchestratorBudget.cjs`) treats a missing window as 16k tokens, which after the output reserve leaves 14,160 bytes, less than an ordinary request with a pane inventory and the tools. The model's window is 262,144 tokens (Ollama's own `/api/show`). The catalog now asks `/api/show` at the endpoint root for every listed model without a window when the endpoint override is in force, and a server without that route leaves the default; `orchestrator-local-brain.test.cjs` pins both. Enabling the Brain on such an endpoint had also been refused outright ("The selected transcription model is unavailable"), because readiness demanded the voice models the server does not serve; voice is now reported off and the text assistant enabled (finding 12 of `orchestratorIntegration.cjs`).

### 13. A second agent in the same project waited for the first one's whole turn

"Prompt the empty codex terminal in vibe terminal to summarize the repo" (T4.11) was compiled, assigned to the spare pane in 29 ms, and then sat `queued` for the full 240 s on runs five and six; the follow-up "and tell it to write that up in the docs folder" (T4.12) failed because nothing had happened. The record shows why: the "add a chat section" task in the same project was still `waiting-results` on a pane whose stub turn never ends, and a managed submission held its project's workspace lane until its turn ended (`docs/orchestrator-tasks.md`: "submissions that may write to the same Git worktree wait for earlier work"). The user's own sentences assume several agents per project ("keep agents on specific tasks", two idle Codex panes, "both terminals that are done"), so the rule was narrowed rather than documented: new work the application itself put in a free pane, or in a pane it opened for it (an assignment decided `create`, or `reuse` for the idle-pane reason), carries a `parallel` workspace lane and runs beside the other panes' work in that worktree. Everything else keeps waiting as before: a first attempt that let every distinct pane through broke 26 pinned ownership tests (explicit targets, incumbent continuations, background children, queued deliveries), which is a contract, not a sentence (`orchestratorTasks.cjs` `conflictingLane`, `orchestrator.cjs` `parallelRoute`, the added case in `orchestrator-routing-scheduler.test.cjs`).

### 14. A continuation plan asked "which agent" before the idle rule could answer

"I have a codex terminal that's not doing anything. Can you prompt it to review everything…" (T2.5, two idle Codex panes) ended in a question on every run. Luna planned it as `plan_continue_task` (continue an existing agent), and the resolver's continue rule ("Which agent should continue? I see: …") ran before the idle rule that picks the first free pane. The idle selector is now honoured inside the continue rule, so a free pane is the answer and the question is kept for the case with none.

### 15. "Which one needs me" and "what's the result" answered from pane memory

"There's a terminal that needs me. Which one is it?" answered "Codex terminal 2 in lina web app is waiting on you", which is a label, not an answer; the pane was started by hand and had no title, but pane memory held its last prompt ("Do a deep dive on the PDF viewer"). The memory answers now receive the pane-memory snapshot: the waiting pane's task is quoted, and "there's a terminal that's done, what's the result?" with two finished panes states both recorded results instead of asking which one (the question remains when a finished pane has no result on record). The interpretation deadline also went from 25 s to 40 s: deepseek-v4-flash and qwen3.7-flash were cut off mid-plan on the long spoken sentences ("the brain took too long") and produced nothing, which is worse than a slow plan.

### 16. "Stop that last terminal you worked on" planned as a prompt, or as a close of three

The ledger rule that picks the pane for a stop request (finding 12 of the previous document: "which pane a stop request means is decided from the ledger, not by the model") only ran when the plan was an `interrupt`. On run seven Luna planned the sentence as `plan_close` with three explicit panes (the close reviewer refused and asked); on run eight as an `operate_terminal` that typed "Stop this terminal." into the pane most recently *talked about* (the Claude pane the two previous questions were about), which the executor then refused to interrupt because that pane was idle. The sentence now decides the kind: a stop, interrupt, pause or halt of "the last terminal you worked on" is an interrupt whatever the plan said, with the targets the plan named handed to the ledger rule as before; a sentence that closes, kills or quits is left alone (`orchestratorIntent.cjs` `stopOfLastWorkedPane`, pinned in `orchestrator-interpretation-fences.test.cjs`). The planner tool descriptions also say it now: stop keeps the pane, `close` is for close, quit and kill.

The first version of finding 15 did not change either answer on run eight, and the record says why: pane memory keeps its records by agent id, and the answers looked a pane up by session id. `paneMemory.bySession(sessions)` addresses the same records by live pane.

Run ten, on a quiet machine, scored 30 again with a single cascade left: "prompt the other one as well" (T4.7), which the corpus allows as a question, was answered by a guess. The target review passed an `other` selector through to the naming checks, so the plan's own pane stood; the guess was an idle pane in a project whose other agent was still working, the request queued on that project's lane for the whole turn, and the pane it eventually woke was "done" by the time of the both-done push and "owned" by the time of "prompt the empty codex terminal", which asked. The review now decides `other` itself: direct when exactly one pane other than the last worked one exists, otherwise assignment's question (`orchestratorTargetReview.cjs`, pinned in the fences test). Run eleven, with that rule, is the best so far: 31 of 35, two allowed questions ("what's the result" with no recorded results, "the other one"), no harm, and the two failures are a one-off failed inspection of the full-screen pane (nine calls; it had answered from memory on every earlier run) and "and tell it to write that up in the docs folder" right after "prompt the empty codex terminal to summarize the repo", which asked which agent to continue. "It" after a delivery is the pane Lina last typed into; the resolver's continue rule now reads it that way (`PRONOUN_CONTINUATION`) before asking.

Run twelve scored 31 again and showed the other face of "the other one": the review handed it to assignment as designed, the resolver found exactly one other Codex pane in the project (the spare) and chose it, which is a defensible reading, and the delivery then waited four minutes on the worktree lane because `other` was not among the selectors allowed to run beside the project's work; the pane it eventually woke made "both terminals that are currently done" three panes for the push two turns later, exactly as on run ten. `other` is now on that list. What remains is the sentence itself: with two candidate panes it is a question (run eleven), with one it is a delivery (run twelve), and only the question keeps the later "both done" turn unambiguous. The rule that settles it is the ledger's: a delivery anchors "the other one" only while it is the latest thing in the ledger; right after a question or an answer there is no "one" to be other than, so the review and the resolver both ask (`lastWorkedPane().fresh`, now in the resolver). Run thirteen, with that rule, is the first clean run: 33 of 35 completed, the other two the allowed questions ("what's the result" with no recorded result, "the other one"), no failure, no harm, 1.5 model calls per turn, $0.05. "And tell it to write that up" completed on runs twelve and thirteen, then queued for the whole turn on fourteen, fifteen and seventeen with its pane idle at the composer the entire time: the pronoun rule handed it the right pane and the same work item, but a continuation carries no selector, so unlike the "empty terminal" delivery it followed it was not allowed to run beside the project's still-working chat-section task and waited on that lane. A continuation now inherits that allowance (`continuation` on the route, `parallelRoute`), and the turn completed on run eighteen. Over the six runs on the finished tree (thirteen to eighteen) the completed count was 33, 30, 30, 32, 33 and 32 of 35, with no harm on five of them; what moves between runs is no longer an app rule but the Brain's own single-call plan on two or three sentences (the both-done push reaching one pane, "make a new Claude terminal to look at the conversations" asking once in eighteen runs, "tell it to continue" answered in two wordings) and, on runs that shared the machine, one timing race.

### 17. A finished Claude task never carried a result

"What did the full screen bug terminal say?" (T4.4) went to the Brain on every run, and on run eleven the Brain's inspection reviewer refused the stub-shaped answer ("RESULT-FS-42") and the turn failed; "there's a terminal that's done, what's the result?" (T4.3) asked which one on every run for the same reason. No run ever had a recorded result for the full-screen pane, which is a Claude pane: the result reader requires the turn end to be `observed`, and a Claude Code turn end comes from its own Stop hook, so the runtime marks it `provisional` and both the capture (`orchestratorCompletion.cjs`) and the validator (`orchestratorResultReports.cjs`) failed closed on it, forever. That is the "finished Claude task has no result summary" item that had been listed as open. A provider that can only report its own end (Claude Code, Gemini, Kimi, Qwen, Cursor, OpenCode, Grok Build) now has its result read at that end, with coverage that says the end was not confirmed on screen; Codex and the chat panes still fail closed on a provisional end, which for them is a transient state before the observed one. Three gates stood in the way, not one, and run fourteen found the other two after the first was opened: the runtime counts a provisional coarse end as possible child activity (`childActivity`, with `coarseChildObservation: 'provisional'` and no child observed), which the validator and the capture refused as a busy child; and the runtime names that end `response`, not `completed`, while the capture stamped every result `completed` and the validator matched the two. A provisional marker with no child is no longer a busy child, `response` is an accepted end state, and the capture keeps the session's own state. Run fifteen then found a fourth gate in front of all three: the app only *remembers* a turn ending that passes the work-history predicate (`orchestratorWork.cjs` `eligible`, reused as "has an observed turn end"), which also demanded `observed` and `completed`, so a Claude ending was never stored and the result reader had nothing to read whatever the validator said. That predicate now uses the same provider-aware rule, with `response` admitted only alongside a provisional observation. On run sixteen every finished pane carried a result (seven recorded, none unavailable) and both questions were answered from memory with no model call: "Fix the full screen bug came back with: the agent reported a completed stub response…". The same run lost its first tier-4 turn to a race it shared with the test gate running beside it: "prompt the agent working on the chat section" arrived before that pane's turn-start hook had landed, the resolver saw no working pane and opened one, and the extra pane skewed the stop and the push two and eight turns later, as on run ten.

### 18. Smaller things the ladder caught

- Two untitled panes in one project made the question "Which one: vibeTerminal or vibeTerminal?"; a repeated label is now told apart by provider and state.
- Codex sets the terminal title to a spinner glyph plus the folder name while it works ("⠼ vibeTerminal"); Lina no longer says or matches the glyph (`paneDisplayName`).
- "Did you enter that prompt?" now answers "Yes, I put … in …" or "No. I tried to put … in …, but it was not sent."
- "There's a terminal that's done. What's the result?" no longer answers from a result row of some other pane; with two finished panes it names both and asks.
- The roster the Brain reads gained a `done` state, so "both terminals that are done" is a fact the Brain can see, and its `free`/`working` words now come from the same predicate assignment uses (a pane whose process reports `running` while its agent sits at an idle turn is free). A fan-out over a state ("both terminals that are currently done") also makes the matching panes of other projects eligible for the roster, which the addressed-project rule used to omit.
- "Stop that last terminal you worked on" read the ledger window the Brain reads (eight rows, two kilobytes) and had already lost the row it needed; the intent normalizer now reads the app's own recent ledger.
- "The agent working on adding a chat section" names a pane started by hand, which carries no title. The sentence still says the pane is working, so with exactly one working pane in the project that is the pane; two are a question by name.
- Codex prefixes its terminal title with an attention banner ("[ ! ] Action Required | lina web app") while it waits; the banner is not part of the pane's name either.
- A prompt refused because the pane is waiting on a question now says so in the user's words ("it is waiting on an answer before it can continue") instead of the transport's.
- A `sourceUserId` that names a request with nothing pending (a finished reply the Brain "continued") transfers no authority and used to end the request as "the unfinished request is unavailable" twice over; the decoder drops it and reads the sentence as the new request it is (T4.14). A source that names a pending command is validated exactly as before.
- An inspection that finished "blocked" had read the pane and found the evidence thin; its text is the answer the user asked for, and the request no longer reports it as "I couldn't do that" (T4.4).
- A pane started by hand is named after its folder, so "vibeTerminal in vibeTerminal is waiting on you" said nothing; such a pane is now named by what it runs and told apart by number ("Codex terminal 2 in lina web app is waiting on you"). A pane Lina started is named by the task she gave it, as the Brain's roster already named it.
- "Tell it to continue" made the Brain supply the answer "Continue.", which the literal-answer rule refused twice because the user had said "continue" without the capital and the period. A supplied answer is now matched on the words, case and end punctuation aside; a literal terminal prompt still has to be exact.

## How small a Brain: the model ladder on tiers 1–3

The same 21 turns (open, start, report, reuse an idle pane, never touch the busy one, "the terminal you just opened", follow-ups, never mind) on cheaper tool-capable Brains from the catalog, one run each, $0.50 cap:

| Brain | $/M in, out | pass | question | fail | harmful | calls/turn | s to first effect | run cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| openai/gpt-5.6-luna (configured) | 0.20, 1.20 | 19 | 1 | 1 | 0 | 1.6 | 4.7 | $0.03 |
| deepseek/deepseek-v4-flash-0731 | 0.06, 0.12 | 12 | 1 | 8 | 0 | 1.9 | 11.4 | $0.009 |
| qwen/qwen3.7-flash | 0.03, 0.13 | 10 | 0 | 11 | 0 | 2.0 | 5.7 | $0.008 |
| openai/gpt-5-nano | 0.05, 0.40 | 9 | 0 | 12 | 6 | 2.1 | 4.0 | $0.014 |
| mistralai/mistral-nemo (12B) | 0.02, 0.03 | 9 | 0 | 12 | 2 | 1.4 | 1.1 | $0.004 |
| deepseek-v4-flash, rerun 2026-09-15 (40 s deadline, lane, continue rule) | 0.06, 0.12 | 13 | 0 | 8 | 1 | 3.2 | 16.7 | $0.019 |
| qwen3.7-flash, rerun 2026-09-15 (two HTTP 429s from OpenRouter) | 0.03, 0.13 | 9 | 0 | 12 | 0 | 1.1 | 5.0 | $0.003 |
| google/gemini-3.8-flash, 2026-09-15, tiers 1–4 (35 turns, compare with Luna's 30–33) | 0.75, 3.75 | 30 | 1 | 4 | 0 | 1.5 | 5.2 | $0.27 |

The Luna row is tiers 1–3 of the fifth full run. What the smaller Brains get right is what the application decides for them: the compiled sentences (open, start), the memory answers (progress report, "did you enter that prompt"), "never mind", and the pane Lina just opened. What they lose is the sentence that needs a plan: "use one of the empty codex terminals to investigate why…" (T2.1–T2.5), where every one of them either opened a new pane beside the idle one, asked, or produced no operation, and the busy-pane follow-up (T3.3). gpt-5-nano and mistral-nemo also did harm (a pane opened where none was wanted, a prompt into the wrong pane); deepseek and qwen did none. deepseek-v4-flash is the cheapest Brain that keeps the tier-1 and tier-3 sentences whole; none of the four is a replacement for Luna on tier 2 as the resolver stands today.

Rerun on 2026-09-15 with the 40 s interpretation deadline, the scoped workspace lane and the continue-before-idle fix (rows above): deepseek-v4-flash completed four of the five tier-2 sentences it had lost ("use one of the empty codex terminals…", the long "there is a codex terminal not doing anything…", "put it in a terminal that's not currently working", the two idle panes), and its remaining failures are the fresh-pane refusals of run nine (the first prompt into a pane it had just opened, refused during the startup repaint, then retried nine to twenty-eight times) and the busy-pane follow-up (T3.3, its plan left the request in routing). qwen3.7-flash lost two turns to OpenRouter rate limiting (HTTP 429) and four to "the brain took too long" even at 40 s. Both reruns shared the machine with a Luna run and the test gate, so their fresh-pane failures carry the same timing caveat as run nine; the age and retry changes described there came after them.

The local-model track (Qwen3.5-2B through Ollama, and `abenzerps/Spark-X2.5-4B-GGUF`, which is pulled into Ollama but untested) was dropped on 2026-09-15 at the user's request to focus on cloud Brains; finding 12 records what the one local run found in the app.

## Tiers 5 and 6 on the configured Brain

| tier | turns | pass | question | fail | harmful | model calls/turn |
| --- | --- | --- | --- | --- | --- | --- |
| 5 (native navigation) | 12 | 0 | 0 | 12 | 8 | 6.1 |
| 6 (hard sentences) | 7 | 4 | 1 | 2 | 0 | 1.3 |

Tier 6 reads as the earlier tiers do: "create a codex terminal in vibeTerminal, prompt it and tell it …" (T6.1), the self-correcting "it's not empty, actually it's just not busy" (T6.2), the complaint that carries a task (T6.3) and the three-project one-line sweep (T6.6) all complete; "prompt the terminal that finished yesterday" asks which one, naming the pane that finished the PDF viewer work (T6.7). The two failures: a question about Lina's own behaviour answered without saying it cannot (T6.4), and "a web terminal" resolving to the Codex Web launcher, which opened a real ChatGPT sign-in in the browser and timed out (T6.5). The harness should keep that launcher out of a run; it did not.

Tier 5 is the first time any navigation turn ran against a live pane, and every one of the twelve failed for one reason before anything else: the Brain attaches a `mouse` object to every `terminal_interact` call ("text": "/status", "keys": ["enter"], "mouse": {"x": 1, "y": 1, "button": "left", "action": "move"}), and the control validator refuses a step that mixes a mouse action with keyboard controls. Seven of the twelve never drove the pane at all; the rest ended with the Brain clicking on a Codex screen that has no mouse tracking ("unsupported-control") or typing a task into a pane it was only inspecting (the eight harmful marks). A mouse "move" beside typed text is a no-op the model adds by habit; the executor now drops it, and a click beside typed text is still refused. Tier 5 was not rerun after that change; its next run is calibration for the navigation profiles themselves (`backend/orchestratorTerminalGuide.cjs`), which no live pane has exercised before.

## Consolidation

The user's standing rule for this work is to replace, not add. Counts before → after:

| what | before | after |
| --- | --- | --- |
| pane-state readers (readiness ladder, memory's own `paneState`, pane memory's own `paneState`, resolver's `idlePaneCandidate`) | 4 | 1 (`paneReadiness` + `paneState`) |
| pane display-name spellings (resolver label, ledger, memory) | 3 | 1 (`paneDisplayName`) |
| "last terminal you worked on" phrase | 2 (intent, review) | 1 (resolver, imported) |
| selector kinds the resolver reads | 6 | 10 |
| Brain-facing fields the app then re-derives (`observationToken` after `observationSequence`/`inputRevision`) | 1 | 0 required |
| readiness facts | 4 | 5 (`untouched`) |

## Harness fixes found by the same runs

- The grader counted a reply composed from records ("ask · replied", naming the pane it was about) as an effect on that pane; replied and answered ledger rows are answers, not actions.
- `resetWorkspace` cancels every request before clearing history (see finding 4).
- Scenario panes with an objective are seeded through Lina herself ("start a codex terminal in lina web app and have it do a deep dive on the PDF viewer. [stub:ask]"), a sentence the command compiler reads with no Brain call and types verbatim, so a seeded pane carries the work item, title and ledger row a Lina-started pane has. Seeding them by typing straight into the pane left every pane named after its project, which is what a hand-started pane looks like and not what tier 4 describes ("which terminal did you give the full screen bug to?"). Idle panes are still simply opened.
- A first write into a pane that has just reached its composer can lose the race with the pane's own startup repaint; setup asks again a few times before giving up on the scenario.
- The host's refusal "Fresh generation-bound terminal interaction evidence is required" now names the field that moved.
- The scratch profile opens no warm spare pane: a scenario describes its workspace exactly, and a pane the app adds on its own is one the grader cannot name (it cost T3.2a on the third run, when the resolver rightly chose the newer of two idle panes).
- A follow-up typed into a working agent is queued behind that agent's turn; the corpus now accepts `waiting-results` for those turns (T3.3, T4.1) with a 20-second settle (`settleMs`), because delivery into the right pane is the completion the sentence asked for and the task settles when the agent gets to it.
- The stub's finished turns print "Done: <the task's first sentence>" under the marker; a reply that was only a marker made the Brain's own finish judgement call every task "blocked" for lack of evidence (T4.9).
- Git's directory is on the harness PATH as a helper (Claude Code runs its hooks through Git Bash on Windows); a probe showed hooks fire under the restricted PATH either way, so this is a safeguard, not the fix.
- The tier-3 reply pattern accepts "put in".

## Verification

- `npm run test:orchestrator`: 2,534 tests green after the 2026-09-14 changes (2,524 before this work; the added and rewritten tests are named as such in their files). On 2026-09-15 the gate wedged twice with its log stopped and the process alive; the cause was the parallel-lane test added that day, which left a job waiting on an admitted loop that the test never finished (a pending scheduler job keeps the process alive, and node's per-file output only prints when the file ends). The test now finishes the free pane's loop and carries a 5 s timeout. Final gate on the finished tree, 2026-09-15 11:15 (with findings 16 and 17, all four result gates, and the "other one" freshness rule): 2,541 tests, 2,541 green, exit 0, ten minutes.
- Probes against the real app on a scratch profile, all in `scratchpad` of the session and reproducible with `scripts/qa/lib/app-harness.cjs`: fresh pane turn facts (finding 1), Claude turn facts after a prompt (finding 2), Codex question attention (finding 3), Claude hook execution under three PATH variants.
- The ladder itself: `--scenario T1.3` alone went from `waiting-results` in 242 s to `finished` in 4 s.

## Open

- **Decided on 2026-09-15: new work the app puts in a free or freshly opened pane no longer waits for another agent's turn in the same project** (finding 13). Work aimed at a pane by name, continuations and background children still wait, as the ownership tests require. If two agents editing one worktree at once turns out to be the problem the lane was guarding against, the `parallel` lane marker is the one thing to drop.
- ~~A finished Claude task has no result summary~~ Fixed on 2026-09-15 (finding 17): a provider that only reports its own turn end has its result read at that end, with coverage saying the end was not confirmed on screen.
- Pending questions survive "clear history" by design; the Brain still sees every unanswered one. Bounding what reaches the Brain, or expiring old questions, is a product decision.
- Tier 5 (native navigation) has not been rerun since the executor started dropping the Brain's mouse "move"; its 0 of 12 above predates that change, and its screen patterns are grounded in the navigation profiles, not in recorded captures.
- T6.5 opened Codex Web, which started a real ChatGPT sign-in in the user's browser; the harness should exclude that launcher.
- "Prompt the other one as well" (T4.7) after "which terminal did you give the full screen bug to?" is ambiguous even to a reader; the corpus allows a question. On run six Luna read it as a repeat of the earlier "tell it to continue" into both lina web app panes, typed "Continue." into the idle one (the run's one harmful action) and spent 16 calls on the waiting one, and the pane it had woken then counted as "done" for the both-done push a turn later. A deterministic rule for "the other one" existed in the resolver (the pane other than the last one used, else a question) but the Brain's own plan carried explicit targets past it; since run ten the review decides it (finding 16), so an ambiguous "other" is a question rather than a guess.
- "Tell it to continue" to a pane parked on a Codex `request_user_input` question cannot be completed by typing: the app refuses a prompt into a waiting pane, and the Brain's attempts to drive the question form by keys race the form's repaint. The user is told the pane is waiting on an answer; answering it for them is not attempted.
- Only Codex and Claude panes are exercised; the other providers' readiness and hooks are covered by `npm run smoke:provider-startup` and their own fixtures.

## Where the records are

Every run's scoreboard, per-model report, the profile's own conversation, ledger, memory and diagnostics files, and every model call's request and response are under `apps/desktop/.tmp/orchestrator-ladder/<run>/`. The runs this document quotes are the ones dated 2026-09-14T20-04 (first run), 20-16 (round 1), 21-10 (round 2), 22-31 (round 3), 23-17 (round 3, corrected seeding), 23-43 (round 4), 2026-09-15T00-07 (round 5), 00-27 (tiers 5–6), 00-40 (model ladder), 01-42 (local Qwen, refused by the context cap of finding 12) and 01-54 (local Qwen after the fix).
