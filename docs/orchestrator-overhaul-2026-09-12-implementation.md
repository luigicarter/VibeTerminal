# Orchestrator overhaul: implementation record (September 12, 2026)

This records what was built from [the overhaul plan](orchestrator-overhaul-plan-2026-09-12.md)
after [the intent and repair deep dive](orchestrator-intent-and-repair-2026-09-12.md),
with the acceptance evidence gathered on the finished working tree. Nothing
here is released or committed at the time of writing; the installed app is
still 0.1.117.

## Results against the targets

| Measure | 0.1.117 | Finished tree | Evidence |
|---|---|---|---|
| Model calls, start or follow-up | 5 to 7 | 1 | live routing probes: continuation 1, targetless create 1, busy follow-up 1 |
| Model calls, named existing pane | 2 | 1 | live-tasks run: 15 calls across 12 requests, zero reviewer rounds |
| Interpretation size, start request | 44,474 chars (18,052 tokens live) | 23,284 chars (4,126 tokens live) | size test; live-tasks diagnostics |
| Interpretation size, plain start | | 19,212 chars | size test, under the 20,000 goal |
| Live-tasks scenario times | 18.5 / 11.8 / 20.1 / 4.3 s | 12.8 / 7.1 / 9.9 / 3.9 s | same four scenarios, before and after the reviewer retirements |
| Submit to interpretation with three 300 ms reads | 939 ms | 316 ms | prefetch test, real fallback path as the baseline |
| App-authored assistant turns in transcripts | yes | none | grep of the request path; dispatcher tests |
| Test suite | 2,166 | 2,371 | `npm run test:orchestrator`, 0 failures |

The 20,000-character target is met for a plain start and missed by 3,284
characters for a start request whose roster carries four panes; the fixed
floor is now the system prompt (7,721) plus the offered tool schemas (5,572).

## What changed, by phase

**Phase 0, the September 12 chain.** App-authored tool calls carry
`type: "function"` and every model request passes `assertTranscriptShape`
first. Provider 4xx explanations reach the diagnostics record. An idle pane
that owns no task is reusable for new work; an explicit idle-pane request
with none free asks "No idle Codex pane is free in vibeTerminal. Open a new
one?". Startup screens are `transient`: the wait keeps polling, reports the
screen once, and answers a folder trust prompt when the folder is a
registered project. A request that fails after opening a pane says so and
keeps the work item retriable.

**Phase 1, speed.** `orchestratorVocabulary.cjs` and
`shared/wakePhraseVariants.cjs` normalize speech variants before the brain
reads a sentence. `fallbackModel` is a new setting with a picker in
Orchestrator settings; `MODEL_DEADLINES` gives interpretation 25 seconds.
Planner tools are gated by mention, the availability field is withheld
unless the sentence asks for a free terminal, and the prompt and schemas
were trimmed. `orchestratorResolver.cjs` replaces the routing rounds and
the affinity reviewer with deterministic selectors and a named question when
two candidates remain. `orchestratorDispatcher.cjs` replaces the forged
handoff: read, send, read, finish run in code; a refused send reaches the
brain as one user-role delivery report. The workspace snapshot, roots and
launcher catalog are prefetched at submit and warmed from the voice path
before transcription. The target-review model call is now
`reviewExistingTargets`, deterministic.

**Phase 2, memory.** `orchestratorLedger.cjs` (one structured line per
request, persisted), `orchestratorPaneMemory.cjs` (per-pane objective,
last prompt, results, a single derived `state`) and
`orchestratorMemory.cjs` (`orchestrator-memory-v1.json`: episodes with
topic tokens, pane and project facts, daily summaries, token and
recency-ranked `recall`, `recall_pane` and `recall_project` tools, rollover,
clear and forget, seeding from the saved conversation store). The brain
receives a 3 KB project-scoped memory block and the roster instead of the
old 12-message window. Questions about Lina's own actions ("what was the
last prompt", "what was that error", "what did that terminal find", "what
did you do in the last ten minutes") are answered from the store with no
model call. Retrieval precision over the utterance corpus: 21 of 22.

**Phase 3, conversation.** A 62-sentence catalogue in
`orchestratorFailureText.cjs` composes every code-written reply with a
written and a spoken form. Progress rows narrate opening, typing, starting,
startup screens and answered prompts once each. "done" is said only when
the effect was observed. A lint test fails the build on blame vocabulary.

**Phase 4, scope and measurement.** `orchestratorAutomaticHandoff.cjs` and
`orchestratorTaskAffinity.cjs` are deleted; the routing rounds,
`ROUTING_SYSTEM`, the interpreter's affinity review and the target-review
reviewer are gone. `npm run measure:orchestrator` reproduces the deep-dive
baseline from the installed profile. The 128-utterance corpus lives at
`apps/desktop/scripts/backend/fixtures/orchestrator-utterances.json`.

## Phase 5, command to action (added the same evening)

Built after the user asked for a faster path from command to action and for
higher fidelity.

- **Command compiler** (`orchestratorCommandCompiler.cjs`), injected through
  the interpreter's `interpretIntent` seam, which may now decline. A strict
  slot grammar compiles open, start, follow-up to a uniquely named or
  just-opened pane, and status or results questions into the same planner
  calls the brain emits, only when the project resolves (named, or the
  addressed workspace view), the provider is known or defaulted from project
  memory, and the task has at least three words with two distinctive ones.
  Never close, interrupt, answers, permissions, or a busy pane. Against the
  128-utterance corpus: precision 100% on every accepted row; 8 rows are
  strictly compilable and 12 when a workspace is addressed, because the
  corpus is raw dictation with garbled frames and anaphora. The live
  existing-owner probe has completed with zero model calls on this tree.
- **Voice endpointing** (`voiceController.cjs`): a 600 ms pause when the
  local turn model reports completion at or above 0.9 (real endings measured
  at 0.94 to 0.98, a mid-sentence pause at 0.06), 1,200 ms otherwise; early
  transcription at 800 ms of silence, aborted if speech resumes, reused when
  nothing was appended; a Whisper vocabulary prompt with project and launcher
  names, confirmed accepted by the OpenRouter transcription endpoint.
  Measured end of speech to relay: 2,300 ms before, 1,700 ms for a confident
  ending, 1,900 ms for an unsure one.
- **Warm spare pane** (`orchestratorSparePane.cjs`, setting `spareAgent`,
  default on): one idle unowned pane of the active project's default agent is
  kept ready, bounded to one app-wide, closed after 30 idle minutes or on a
  project change, never under memory pressure. The resolver's idle-pane rule
  reuses it, so a start in that project skips creation entirely.
- **Interpretation model** (setting `interpretationModel`, optional): a
  separate, faster model for the interpretation call only; replies and results
  keep the brain; timeouts fall back to the configured fallback, else the
  brain.
- **Fidelity harness** (`scripts/qa/orchestrator-fidelity-live.cjs`): the
  corpus carries an expected plan per row; the compiler is scored offline and
  the brain live. First full brain sweep on this tree: verb 27.2%, project
  77.2%, provider 83.7% over 92 rows for $0.32. The verb number is not yet a
  fair measure: the harness calls the interpreter directly, so the rows the
  relay answers from memory with no model call score as misses, and the
  corpus verb labels are finer than the planner's operation set. Calibrating
  the scorer is the next step before the number is tracked per release.

Gate on the finished tree, run by the planner: 2,371 tests, type check,
build, routing smoke and resolver self-test green; live routing probes at one
call each; live-tasks four of four.

## Acceptance evidence, all run by the planner on the finished tree

- `npm run test:orchestrator`: 2,323 pass, 0 fail; `npm run typecheck`
  clean; `npm run build` clean; `npm run smoke:frontend:orchestrator-routing`
  passed; resolver self-test passed for 9 cases; `git diff --check` clean.
- `node scripts/qa/orchestrator-routing-live.cjs --existing-owner`: 1 call,
  `send_prompt` to the titled owner. `--end-to-end`: targetless create 1
  call, busy follow-up 1 call.
- `npm run smoke:orchestrator:live-tasks`: all four scenarios ok.
- The September 12 reproduction (disposable relay, fixture that refuses
  the first send): the idle-pane sentence now asks before opening a pane;
  the create-path sentence opens the pane, reports the startup screen, and
  every fallback call to the brain returns 200. Live spend for all probes and
  reproductions today was under one dollar.

## Product-visible changes to know about

- Idle unowned panes are reused for new work instead of opening another.
- The folder trust prompt is answered automatically for registered
  projects, and the reply says so.
- "The selected agent has no unique live owner" no longer occurs; Lina asks
  which pane by name.
- Progress lines appear within two seconds of a slow step.
- A fallback brain can be configured; 16K-context brains now fit.
- Failure text names the pane and what happens next; the provider's own
  sentence stays in the receipt and diagnostics.

## Not done or still open

- The 20,000-character interpretation target for a four-pane start request
  (23,284 today); the next lever is gating close, interrupt, focus and watch
  tools behind mention.
- The optional early-transcription overlap at 800 ms of silence.
- `scripts/qa/orchestrator-recovery-live.cjs` was updated to the resolver
  contract but not run.
- A bare "tell the Codex terminal in Alpha to X" reaches the provider-project
  rule only through the resolver path; widening `eligibleExistingTargets`
  would let the direct path take it.
- One retrieval miss in the corpus (row 46) from exact-token matching
  ("reported" versus "Report").
- End-to-end latency on the installed app is measurable only after a release
  with these changes; the measurement script will show it.
- Nothing is committed; the working tree also holds unrelated work from
  another session (mobile app, brand assets, root scripts), untouched.
