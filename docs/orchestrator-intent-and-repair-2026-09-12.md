# Orchestrator: intent, failure audit and repair plan (September 12, 2026)

This document answers three questions about the Orchestrator as installed in
0.1.117: what it exists to do, how well it does that today, and how to fix it.
It supersedes the recommendations section of
[the September 11 deep dive](orchestrator-deep-dive-2026-09-11.md); the
de-serialization packages in
[that plan](orchestrator-deserialization-plan-2026-09-11.md) shipped in
0.1.117 and are assumed below.

## Evidence used

- Installed profile `%APPDATA%\vibe-terminal`: `orchestrator-conversation.json`
  (128 tasks, 342 messages, 229 receipts, September 7 to 12),
  `orchestrator-work-items.json`, `orchestrator-agents-v1.json`,
  `logs/orchestrator-errors.jsonl` (request diagnostics since the 0.1.117
  install at 13:19 on September 12; the two rotated files are voice telemetry
  only).
- Installed build confirmed as 0.1.117 from `resources/app.asar`.
- A live reproduction of the September 12 HTTP 400 against the configured
  brain (`google/gemini-3.8-flash`) with a disposable in-memory relay, and a
  replay of the rejected request body with single-field corrections. Both
  scripts follow `scripts/qa/orchestrator-routing-live.cjs`; total cost
  $0.016.
- Source: `apps/desktop/backend/orchestrator*.cjs` (78 files, 11,165 lines),
  139 test files (19,274 lines), and the seven Orchestrator docs.

## 1. What the Orchestrator exists to do

Lina Terminal's product is a board of coding agents running side by side. The
Orchestrator is the hands-off layer over that board: the user says one
sentence, and the right pane gets the right prompt, or a new pane appears, or
the user hears what a pane did. Its value is entirely in reliability and
trust. If the user has to check the pane after every sentence, it is slower
than typing into the pane.

The 128 saved requests show what the user actually asks for. Classified by
hand:

| Ask | Requests | Examples |
|---|---|---|
| Start work in a project (new pane, or an empty/idle one) | ~35 | "use one of the empty Codex terminals to investigate...", "have a Codex terminal fix the full-screen issue" |
| Verify Lina's own last action, or repeat it | ~20 | "you didn't put in that prompt", "what was the last prompt I asked you to put in?", "put it in now" |
| Status and results | ~18 | "there's a terminal that's done, what's the result?", "which terminal needs me?", "tell me when they're done" |
| Follow up with a specific agent | ~15 | "tell it to fix those issues", "tell the agent working on the chat section to continue" |
| Open blank panes | ~10 | "open a Codex terminal in vibeTerminal", "open five terminals in Lena web app" |
| Questions about Lina herself | ~10 | "are you able to queue prompts?", "what was that error?", "why didn't you do my last request?" |
| Cancel or noise | ~10 | "never mind", "did you get that?" |
| Close, clear, stop | ~7 | "close the three that are inactive" |
| History, resume, native state | ~6 | "resume the ... conversation", "do /status and tell me the usage" |

Four verbs cover almost everything: start, follow up, report, tidy. The second
row is the damning one: one request in six was the user checking whether the
prompt landed, because the app said "done" or "sent" and the pane showed
nothing. Setups, preferences, navigation, folder operations, watch, and
resume, which are 15 of the 23 planner tools and a large share of the
9,100-character interpretation prompt, were asked for a handful of times in
total.

## 2. How well it serves that intent

Outcomes over the six days, from the conversation store:

| Measure | Value |
|---|---|
| Requests | 128 (all voice) |
| Finished | 74 (58%), including "never mind" and questions |
| Ended in an error | 33 (26%) |
| Cancelled by the user | 20 (16%) |
| Likely repeats within five minutes | 13 |
| Write attempts rejected by the app | 62 of 128 (send, interact, finish) |
| Requests per day | 48, 29, 36, 7, 7, 1 |

The last row is usage decay: the user tried hard on the first three days and
almost stopped. Errors the user saw were generic: "One or more requested
actions failed. Check the action receipts." (7), "I could not interpret that
request." (6), "OpenRouter could not accept this request. Check the selected
model and settings. (HTTP 400)" (4), "The OpenRouter request timed out." (3),
"Local context limit" (3), "The terminal changed before its result could be
verified." (3). None of these names the pane, the cause, or what to do.

Write rejections were concentrated on September 7 (the Mercury 2.5 era: 32
"terminal changed after the last observation" and 20 "use bounded literal
text" refusals), and dropped after the busy-Codex path and the reviewer
repairs shipped. Deliveries dropped with them: 36, 17, 10, 1, 3, 0 written
prompts per day.

## 3. The September 12 exchange, as a worked example

Request at 14:13: "Can you use one of the empty Claude Code terminals in the
vibe terminal project to investigate the performance of the orchestrator."
Diagnostics for `aade1c24`:

1. Interpretation, one call, 18,052 prompt tokens, fine.
2. Routing: `list_sessions` (10 candidates), `find_agents` (0), `read_session`,
   then `choose reuse` of an existing pane. Four calls, 9 seconds. Correct.
3. Affinity review on that pane: `independent`. Correct, the pane owns
   nothing.
4. `orchestrator.cjs:842-849` converts reuse plus independent into
   `deterministicNewTaskRoute`, reason "No verified same-task ownership; this
   objective gets a separate agent conversation." **Bug: the user's explicit
   instruction is overridden by app policy.** There is no code path that lets
   an idle pane with no work item take new work; the router and affinity
   prompts forbid it in prose.
5. `create_session` opens "Open Claude Code 11" (kind `claude-custom`, config
   home `custom:default-custom`). That home has never trusted the vibeTerminal
   folder, so the pane shows "Do you trust the files in this folder?".
6. The application handoff sends `read_session` then `send_prompt` 60 ms
   later. `orchestratorPromptReadiness.cjs:30-31` classifies the trust screen
   as `blocked`; `orchestratorLaunchers.cjs:139` fails at once with
   `input-surface-unverified` instead of polling (only `starting` polls, line
   144). **Bug: a transient interactive screen is treated as terminal, with no
   wait, no answer, and no message to the user.**
7. The handoff falls back to the model. The transcript now holds two
   app-authored assistant turns whose `tool_calls` lack `type: "function"`
   (`orchestratorAutomaticHandoff.cjs:38,54`; the direct branch at
   `orchestrator.cjs:1505` has the same shape). Google rejects it: "Tool-call
   assistant message produced no valid function calls but is followed by tool
   result messages. The conversation transcript is malformed." Two attempts,
   both 400. **Bug, reproduced and isolated:** replaying the rejected body with
   `type: "function"` added returns 200; renaming the tool alone still fails.
   The two September 11 400s followed Codex `launch-timeout` sends and have
   the same shape.
8. The user sees "Check the selected model and settings." The provider's
   sentence was captured into `providerMessage` and dropped before the
   diagnostics record was written (`openRouterErrors.cjs:32-43`). **Bug: the
   only informative fact never reaches the log or the user.**
9. The reply is the error text alone (`orchestrator.cjs:1734`); the created
   pane sits in a machine-readable `actions` field the renderer does not show.
   **Bug: a side effect the user must clean up is never mentioned.** Three
   such orphans exist.

Coverage: no test asserts the `assignment_affinity` stage, and all eleven
saved routing-probe runs from September 11 produced only `same-task` or
`unclear` verdicts. The branch that broke has never been exercised by a check.

## 4. Why it fails: the structural diagnosis

The individual bugs above are symptoms of six design choices.

1. **Truth is split across too many model judgments.** One request can pass
   through the interpretation planner, a target review, a close review, a
   creation-purpose classifier, an inspection classifier, up to eight routing
   rounds, an affinity review, an execution loop and a goal review. Each has
   its own JSON contract and a validator that fails closed to "unclear",
   "clarify" or a generic error. With a fast cheap brain each stage fails a
   few percent of the time; chained, the request fails often and at random,
   and the failure is always reported by the last stage, never the cause.
2. **Safety is optimized against the wrong risk.** The observation-token
   fence, the ownership rule (one pane, one work item, same task only), and
   the fail-closed readiness heuristics all exist so Lina never types into the
   wrong pane or at the wrong moment. On a single-user desktop where every
   pane is visible and Esc undoes a wrong prompt, the cost of not acting is
   far higher than the cost of a visible mistake. The design produced the
   opposite of trust: 62 rejected writes and 20 "you didn't put it in" turns.
3. **App policy outranks the user's words.** "Use the empty terminal" became a
   new pane; "tell the chat-section agent to continue" became a refusal ("no
   unique live owner") and then a new pane. The rules protecting continuity
   were written for busy, owned panes and applied to empty ones.
4. **The app forges model history.** The automatic handoff pretends the model
   made tool calls it never made. That is provider-specific and fragile (the
   400), and it is unnecessary: the handoff is application logic and can hand
   the model a plain summary instead of a fake transcript.
5. **Screen heuristics are brittle and silent.** Readiness depends on regexes
   over decoded screens per provider ("Codex session header", "Do you
   trust"). Two Codex launches timed out after 60 seconds on September 11 for
   reasons the rotated log no longer holds. When a heuristic blocks, the user
   is not told what the screen shows.
6. **Replies hide what happened.** "done", "Input was sent to vibeTerminal; I
   haven't confirmed that the task started", "the terminal changed before its
   result could be verified" (a generation change, `orchestratorTasks.cjs:354`)
   and the generic errors give the user no pane name, no typed text, no
   observed effect, and no next step. Questions about Lina's own actions
   ("what was that error?") fail interpretation entirely.

## 5. What good looks like

Principles derived from the intent, used to rank the plan:

- **Act, show, undo.** Deliver whenever a pane is identified; state which pane
  and what was typed; make "undo that" and "not that one, the other" cheap.
  Ask only when two named candidates remain.
- **Code decides what code can know.** Idle, owned, busy, waiting, done,
  title, provider, folder and recency are already in the session registry and
  the sidebar status telemetry. No model call should re-derive them.
- **One model call to understand, at most one to write prose.** The brain
  turns speech into a verb, a project, a pane selector and a prompt. Prose is
  only needed to summarize output or answer a question.
- **Every reply is verifiable against the pane.** Pane name, typed text,
  whether the agent started, and the reason when it did not.
- **Failures name the cause and the side effect.** Never "check your
  settings" for an app bug; never a silent orphan.

## 6. Repair plan

### Package A: correctness and honesty, shippable as 0.1.118

1. **Valid app-authored tool calls.** Add `type: 'function'` at
   `orchestratorAutomaticHandoff.cjs:38,54` and `orchestrator.cjs:1505`. Add a
   transcript validator in `orchestratorExecutionHarness.cjs` that refuses to
   send an assistant turn whose `tool_calls` lack `type`, `id` or
   `function.name`, throwing an app-bug error rather than a provider one.
   Test: a handoff whose send fails produces a transcript that passes the
   validator; the live end-to-end probe gains a `send-refused` case that
   expects 200 on the fallback call.
2. **Diagnostics that explain 4xx.** Include `providerMessage` (already
   redacted and capped) in `upstreamErrorInfo`, and write the rejected
   request's message roles, tool-call ids and `type` fields to the diagnostics
   record. Do not re-send an identical body after a 400; the second attempt
   is wasted.
3. **Idle-pane reuse.** In `prepareTaskAssignments`, before the affinity
   review: if the candidate pane has no work-item binding, is `observed`, its
   turn state is idle or completed, and nothing is pending, adopt it for the
   new work item with reason "idle unowned pane" and skip the reviewer.
   Recommended policy: an unowned idle pane is always reusable for new work;
   that is what "empty terminal" means to the user, and the one-owner rule at
   `orchestrator.cjs:861` still protects owned panes. If the instruction
   named an idle pane and none exists, ask "No idle Claude Code pane in
   vibeTerminal. Open a new one?" rather than creating silently.
4. **Transient startup screens.** Split `blocked` into `blocked-transient`
   (trust, sandbox, sign-in, hooks review) and `blocked-final` (pending
   question or manual input). Transient keeps polling to the startup deadline
   and publishes a lifecycle report at once: "Claude Code in vibeTerminal is
   asking to trust the folder." Recommended policy: auto-answer the trust
   prompt when the folder is a registered Lina project, then report that it
   was answered; the project registry is the user's own trust evidence.
5. **Orphans and retries.** When a request fails after `create_session`,
   append "I opened Claude Code in vibeTerminal but could not send the task;
   the pane is still open." Keep the work item bound to that pane in a
   `retriable` state so "put in that prompt" continues there instead of
   opening a fourth pane.
6. **Specific failure text.** Map `input-surface-unverified`,
   `launch-timeout`, `stale-observation`, the generation-change wait failure
   and the 4xx family to sentences that name the pane and the observed
   screen state.

Done when: `npm run test:orchestrator` passes with the new tests; the
end-to-end probe's `send-refused` case returns 200 on the fallback call;
a spoken "use one of the empty Claude Code terminals" against a live idle
pane delivers to that pane; a fresh Open Claude Code pane in a registered
project receives its prompt after the trust screen; the September 12 request
replayed through the fixture yields a reply naming the pane and the cause.

### Package B: deterministic resolver replaces model routing

Replace the routing planner rounds and the affinity reviewer for the four
main verbs with code over the session registry, work items and status
telemetry:

- Selector vocabulary from interpretation: by title or topic words, "empty",
  "idle", "the one you just opened", "the one that's done", "the one that
  needs me", "all of them", by provider.
- Ranking: exact title, topic overlap with title and objective, recency of
  Lina's own last action, then status. One candidate: go. None: create when
  the verb permits, else ask. Two or more: one question listing them by
  human name, never "no unique live owner".
- Keep the existing-owner shortcut as the first rule of the resolver.

Done when: calls per start or follow-up request drop from 5 to 2 or fewer on
the routing probe; the `--existing-owner` probe passes with two similarly
titled panes by asking a named question.

### Package C: application-owned handoff

The handoff runs read, send, and finish in code and never writes assistant
turns. If it must fall back to the model, it adds one user-role message:
"Delivery to <pane> was refused: <reason>. Screen: <excerpt>." The model's
own tool calls remain the only assistant turns. Delete the `agent-handoff`
call synthesis.

### Package D: reply contract

Templated replies for start, follow-up, open and close: pane name, typed
text, and started or not, with the reason. The brain writes prose only for
results and questions, and is given the request log so "what was that
error?" and "what was the last prompt?" are answered from receipts.

### Package E: scope and prompt weight

Stop feeding setups, preferences, folder operations and navigation into every
interpretation (18,000 prompt tokens per request today). Offer them only when
the utterance mentions them, or retire the ones with no usage. Measure: prompt
tokens per interpretation, p50 latency, and the non-completion rate from the
conversation store, reported per release.

### Sequencing

A first, alone, as 0.1.118. B and C together next; they remove the code that A
patches around. D with B. E last, or opportunistically. Each package keeps the
delivery substrate (`orchestratorDelivery.cjs`, `orchestratorLaunchers.cjs`,
`orchestratorTerminalInput.cjs`, `orchestratorTasks.cjs`, PTY fences), which
is the part of the harness that is well tested and correct.

## 7. Decisions for the product owner

1. Idle unowned pane: always reusable for new work (recommended), or only when
   the user names it.
2. Trust prompt: auto-answer for registered projects (recommended), or always
   ask.
3. Ambiguity: ask with named candidates (recommended), or pick the most
   recent and say so.
4. Scope: retire unused planner operations, or keep them behind mention
   gating.

## 8. Open questions

- Three September 11 Codex tasks failed with "the terminal changed before its
  result could be verified", which means the pane's generation changed 4
  seconds, 17 seconds and 12 minutes after the prompt was written. Something
  re-created those panes; the rotated log no longer says what.
- Two September 11 Codex launches never showed a ready composer within 60
  seconds ("The Codex session header has not finished loading"). Whether this
  is the bundled Codex version or the readiness regex is not determinable
  from the surviving evidence.
