# Orchestrator overhaul plan (September 12, 2026)

This is the execution plan for the diagnosis in
[the intent and repair deep dive](orchestrator-intent-and-repair-2026-09-12.md).
It covers the whole overhaul in five phases, adds a speed budget, and adds a
memory design that replaces the raw conversation window the brain reads
today. Each phase ships on its own with the measurement script run before and
after, so progress is comparable with the numbers in the deep dive.

## Targets

| Measure | Today (0.1.117) | Target | Finished tree (see the implementation record) |
|---|---|---|---|
| Model calls per start or follow-up request | 5 to 7 | 2 or fewer | 1 |
| End of speech to first terminal effect, p50 | about 13 s | 4 s | measurable after release; harness scenarios 12.8 / 7.1 / 9.9 / 3.9 s from 18.5 / 11.8 / 20.1 / 4.3 s |
| Prompt tokens per interpretation | 18,000 | 5,000 | about 4,100 live (23,284 chars; plain start 19,212) |
| Non-completion rate, rolling 50 requests | 42% | under 10% | measurable after release |
| "Did you put the prompt in?" follow-ups | 1 in 6 | 0 | answered from memory with no model call |
| App-authored assistant turns in any transcript | yes | none | none |

Where the 13 seconds go today, from the September 12 diagnostics: 1.2 s
end-of-speech pause, 1.1 s transcription, 1.7 s interpretation, 6.3 s of four
routing rounds, 1.3 s affinity review, 1.5 s pane creation. The plan removes
the routing rounds and the review entirely and overlaps the rest.

## Phase 0: hotfix release 0.1.118 (Package A, 1 to 2 days)

Files: `apps/desktop/backend/orchestratorAutomaticHandoff.cjs`,
`orchestrator.cjs`, `orchestratorExecutionHarness.cjs`,
`openRouterErrors.cjs`, `orchestratorModelRuntime.cjs`,
`orchestratorPromptReadiness.cjs`, `orchestratorLaunchers.cjs`,
`orchestratorTaskReports.cjs`, `orchestratorResponse.cjs`.

1. Add `type: 'function'` to the tool calls built at
   `orchestratorAutomaticHandoff.cjs:38` and `:54` and in the direct branch at
   `orchestrator.cjs:1505`. Add `assertTranscriptShape(messages)` in
   `orchestratorExecutionHarness.cjs`, called before every completion: every
   assistant `tool_calls` entry needs `id`, `type` and `function.name`, and
   every tool message needs a preceding matching id. Failure throws an
   app-bug error whose text says so.
2. `upstreamErrorInfo` in `openRouterErrors.cjs` includes `providerMessage`.
   The `orchestrator_error` record also carries the message roles and
   tool-call ids of the rejected body. In `completionWithFallback`, a 400
   whose repair changes nothing about the body is not retried.
3. Idle unowned pane reuse in `prepareTaskAssignments`, before the affinity
   review at `orchestrator.cjs:831`: a candidate with no work-item binding,
   `observation === 'observed'`, idle or completed turn state, and nothing
   pending is adopted for the new work item with reason "idle unowned pane".
   If the instruction asked for an idle pane and none exists, ask "No idle
   Claude Code pane in vibeTerminal. Open a new one?" instead of creating.
4. Split readiness `blocked` into `blocked-transient` (trust, sandbox,
   sign-in, hooks review) and `blocked-final` (pending question, manual
   input). `waitForNativePromptReady` keeps polling on transient and
   publishes a lifecycle line at once. When the folder is a registered Lina
   project, the app answers the trust prompt through the existing
   `terminal_interact` path and reports that it did.
5. On failure after `create_session`, the reply appends "I opened <provider>
   in <project> but could not send the task; the pane is still open." The
   work item stays bound to that pane in a `retriable` state, and the next
   "put in that prompt" resolves to it.
6. Specific text for `input-surface-unverified`, `launch-timeout`,
   `stale-observation`, the generation-change wait failure at
   `orchestratorTasks.cjs:354`, and the 4xx family: pane name plus observed
   screen state.

Done when: new unit tests for each item pass in `npm run test:orchestrator`;
the end-to-end live probe gains a `send-refused` case whose fallback call
returns 200; the September 12 request replayed through the disposable relay
produces a reply naming the pane and the cause.

## Phase 1: speed, two calls per request (Packages B and C, 4 to 5 days)

### 1.1 Vocabulary normalization before interpretation (code)

New `orchestratorVocabulary.cjs`. Speech recognition wrote "cloud code",
"codec", "codecs", "cortex", "Vybe", "Vibeturnal", "Lena web app", "Alina",
"Elena" across the saved transcripts. A deterministic pass maps provider
names, wake-word variants and project names (built from the project list,
with a small phonetic alias table) to canonical forms, strips a leading wake
phrase in any variant, and records `normalizedText` beside the original. The
brain and the resolver see the normalized text; the conversation shows the
original.

### 1.2 One slim interpretation call

`orchestratorInterpreter.cjs` and `orchestratorPlannerTools.cjs` keep the
planner-tool wire format and validators, but the payload shrinks to:
normalized instruction, project names, launcher names, the action ledger
(Phase 2), the pane roster for the addressed project (id, name, provider,
status, owner objective up to 80 characters), and up to ten preference lines.
Tools for setups, preferences, folders, navigation, resume and history are
offered only when the normalized text mentions them (a keyword gate in
`plannerTools`). The system prompt drops the paragraphs that describe those
tools when they are not offered. Target: 5,000 prompt tokens.

The interpretation output for the four main verbs is a verb, a project, a
selector, a provider, a prompt, and optionally a reply or question. Selector
kinds: title or topic words, empty or idle, just opened, done, needs me, all,
provider, ordinal.

### 1.3 Deterministic resolver replaces routing rounds and affinity review

New `orchestratorResolver.cjs`, called from `prepareTaskAssignments` in place
of `planTaskRoute` and the affinity block at `orchestrator.cjs:817-850`.
Inputs: the selector, the pane roster, work items, the ledger. Rules, in
order:

1. Existing-owner shortcut (`orchestratorOwnerMatch.cjs`) stays first.
2. Score each pane: exact title, token overlap of selector words with title
   and objective, ledger recency ("just opened", "the one I sent to"), status
   match ("done", "needs me", "empty"), provider match.
3. One candidate above threshold: assign. None: create when the verb allows
   it ("open", "start", "have a Codex terminal") or ask otherwise. Two or
   more: ask one question naming up to three candidates by human title.
   Exception: verb start with selector empty picks the most recently idle
   pane and says which.

Retire: the routing rounds in `orchestratorRoutePlanner.cjs`, the reviewer in
`orchestratorTaskAffinity.cjs`, `orchestratorTargetReview.cjs`, and the
creation-purpose and inspection classifiers in the interpreter. Their tests
become resolver table tests built from the 128 real utterances with expected
verb, project and selector; that fixture file is the regression corpus for
every later change.

### 1.4 Handoff in application code

New `orchestratorDispatcher.cjs` replaces `orchestratorAutomaticHandoff.cjs`.
For start and follow-up it runs create (if needed), wait for ready, send,
observe start, and reply from a template, without a model round. If the send
is refused, it does not forge a transcript; when a model round is still
needed (results, questions), it adds one user-role message: "Delivery to
<pane> was refused: <reason>. Screen: <excerpt>." Assistant turns in any
transcript come only from the model.

### 1.5 Overlap and early replies

- Fetch the workspace snapshot, launcher catalog and pane roster while
  transcription runs; start interpretation the moment text arrives
  (`voiceController.cjs` and the `send` path in `orchestrator.cjs`).
- Reply "Opening Codex in vibeTerminal" as soon as creation starts, then the
  delivered or refused line as a lifecycle report. The user hears progress
  within two seconds instead of after the 20 s startup budget.
- Optional: send the recording to transcription at 800 ms of silence and
  discard the result if speech resumes before the 1,200 ms pause; saves about
  one second per turn.

### 1.6 Model transport

- Interpretation deadline 45 s to 20 s. Settings gain an optional fallback
  brain; a timeout or 5xx on the primary retries once on the fallback. Three
  of the 31 saved errors were plain timeouts.
- Keep structured outputs; keep `tool_choice: auto`.

Done when: routing probe shows 2 or fewer calls for start and follow-up;
`--existing-owner` with two similar titles asks a named question; measured
end-of-speech to first effect p50 under 4 s on five spoken requests; the
utterance corpus passes.

## Phase 2: memory management (2 to 3 days)

### Why the current context confuses the brain

`orchestrator.cjs:1142` hands the brain the last 12 messages of other
requests, including system error lines and assistant prose, plus
`lastFailure`, a task snapshot, and the previous exchange's last four messages
as `replyContext`. The implicit reply target is the latest exchange even when
the new sentence is about something else. `fitMessages` trims from the oldest
entry when the payload overflows, so references shift without notice. The
execution transcript grows with tool bodies until the 48,000-byte ceiling,
which produced the three "Local context limit" failures. And the raw text
carries speech-recognition variants of every name.

### Three tiers, built by code, with fixed budgets

**Tier 1, action ledger.** One structured line per request, written by the
app from receipts and waits, persisted in `orchestrator-conversation.json`:
request id, time, verb, project, pane (id, name, provider), typed text up to
300 characters, outcome (delivered and started, delivered but unconfirmed,
refused with reason, created only, answered, closed, failed with reason). The
brain receives the last eight lines, about 1 KB, instead of 12 KB of prose.
This is what makes "put in that prompt", "the one you just opened", "what was
the last prompt?" and "what was that error?" resolvable by code or by one
short model reply.

**Tier 2, pane memory.** Per pane, in the agents store: the objective Lina
gave it, its title, last prompt time, last result summary up to 400
characters (from the existing result reports), status. The roster shown to
the brain is this record, never screen text. Screen text is read only for
results and needs-me requests, and a fresh result summary answers "what's the
result?" without a read.

**Tier 3, durable preferences and vocabulary.** The existing preference store
plus learned aliases: a project name variant that resolved successfully is
saved as an alias for the normalizer. Injected as at most ten lines.

### Hygiene rules

- Per-request model transcripts are never carried across requests; failed and
  cancelled requests appear only as ledger lines.
- A sentence that names a project or pane drops the implicit reply target;
  "never mind" clears the pending question and the implicit target.
- Byte budgets per tier (ledger 2 KB, roster 4 KB, preferences 1 KB,
  enforced in code before `fitMessages`), so `fitMessages` never has to trim
  conversation context.
- Clear history clears Tier 1 and the brain-facing parts of Tier 2, keeps
  pane ownership, as today.
- The user can ask "what did you do in the last ten minutes?" and gets the
  ledger read back.

Files: new `orchestratorLedger.cjs`, `orchestratorPaneMemory.cjs`; changes in
`orchestrator.cjs:1140-1215`, `orchestratorReplyContext.cjs`,
`orchestratorConversationStore.cjs`, `orchestratorAgentStore.cjs`,
`orchestratorBudget.cjs`.

Done when: the interpretation payload contains no raw prior messages; a
saved-history replay of the September 8 sequence ("you didn't put in that
prompt", "what was the last prompt?", "put it in now") resolves each turn to
the right pane and text from the ledger with one model call each; the
"Local context limit" error can no longer occur on start or follow-up
because those verbs have no execution transcript.

## Phase 2b: memory as a store with retrieval, not a window (2 to 3 days)

Phase 2 replaced the raw conversation window with three code-built tiers,
but the brain still only sees the last eight ledger lines and one project's
roster. Anything older is out of reach, there is no project-level memory,
and a pane keeps a single result summary. Phase 2b turns memory into a
persisted store with deterministic retrieval, so the injected context stays
small and everything else is one lookup away.

### Data model

One dedicated store, `orchestrator-memory-v1.json` under userData (not the
conversation store, whose 10 MB message pool evicts by age), holding
append-only records with `at`, `source` (request id) and a type:

- **episode**: the ledger entry plus `topics` (stopword-filtered tokens of
  the instruction, typed text and result), `results[]` (up to five result
  summaries of 400 chars), and the pane and project it touched.
- **paneFact**: objective, title, provider, status, created by Lina or the
  user, the last user phrase that referred to it, last five results.
- **projectFact**: default provider (mode of the last twenty starts), last
  active pane, last three results, open questions, name aliases.
- **userFact**: explicit preferences (existing store) plus stated rules
  such as "always use Codex in vibeTerminal"; never inferred silently.
- **summary**: one code-written line per project per day, produced at
  rollover, so the gist survives eviction.

Derived indexes rebuilt on load and kept current on write: by pane, by
project, by day, and an inverted token index (topic to episode ids).
Ranking is token overlap times recency decay; no embeddings. Retention:
episodes 90 days or 5,000 rows, facts bounded at 500 panes and 100 projects.

### Write path, code only

Episodes are written at request settle (the existing ledger hook) and
extended by `publishTaskDetails` with each result summary. Pane facts are
updated on binding, send and result. Project facts are recomputed from the
last twenty episodes of that project. Seed on first load from the existing
conversation store so memory is not empty after the update.

### Read path: small injection, cheap retrieval

Injected on every call, 3 KB total: the addressed project's block (default
provider, last active pane, last two results at 120 chars), the last five
episodes of that project, the pane roster, and one line for activity
elsewhere today. Retrieval tools for the brain, read-only and bounded to
4 KB, each citing request id and time: `recall({ query, pane, project,
since, limit })`, `recall_pane({ paneId })`, `recall_project({ project })`.
A memory-backed fast path answers the corpus's verify, status and results
questions ("what was the last prompt", "what did X find", "which pane did I
send that to") from the store without a model call when a template matches;
the brain phrases only when needed.

### Hygiene

Budgets are enforced per block in code before `fitMessages`. Naming
another project drops the implicit target (existing). Rollover on the first
request of a new day and on clear-history writes the per-project summary
lines. Clear-history wipes episodes and summaries and keeps the pane and
project facts ownership needs; "forget everything about X" wipes X's facts.
Secrets are redacted at write; nothing leaves the machine except the
bounded blocks a brain call carries.

### Tests

Indexing and ranking tables; retrieval precision on the 128-utterance corpus
(a results question resolves to the episode of the pane it names);
injection budget; rollover and summary; clear and forget semantics; a
payload test proving no raw prior prose reaches the brain; seeding from a
saved conversation store.

Done when: "what did the review recent orchestrator messages terminal say?"
answers from memory with zero or one model call; the interpretation payload
carries only the project block, five episodes and the roster; the store
survives restart and clear-history behaves as specified.

## Phase 3: reply contract (Package D, 1 to 2 days)

Templates in `orchestratorResponse.cjs` for start, follow-up, open, close and
refuse: pane name, typed text, started or not, reason. The "done" cue only
when the effect was observed started. The brain writes prose only for results
and questions, and receives the ledger so questions about Lina's own actions
are answered from facts. Voice replies stay under three sentences unless the
user asks for detail.

## Phase 4: scope and weight (Package E, 2 days)

Gate rarely used operations behind mention (Phase 1.2) and retire what has
no usage after two releases. Delete the retired reviewers and the routing
rounds; migrate or delete their tests. Add `npm run measure:orchestrator`,
which reads the installed conversation store and diagnostics and prints
calls per request, p50 time to first effect, prompt tokens per
interpretation, and the non-completion rate. Run it before and after every
phase.

## Phase 5: command to action, faster and more faithful (3 to 4 days)

After Phases 0 to 4 a start request costs about 6 seconds from the end of
speech: 1.2 s pause, 1.1 s transcription, about 2 s interpretation, 1.5 s
pane creation. Phase 5 attacks each segment and adds a fidelity harness so
the gains do not cost accuracy.

### 5.1 Deterministic command compiler

A local interpreter (`orchestratorCommandCompiler.cjs`) injected through the
existing `interpretIntent` seam of `createIntentInterpreter`. It parses the
normalized sentence with a strict slot grammar (verb phrase, provider,
project, pane selector, prompt text) and returns the same planner-tool calls
the brain would (`plan_delegate_task`, `plan_open_blank_terminal`,
`plan_continue_task`, `plan_conversation` for status and results), so
`decodePlannerCalls` and `normalizeIntent` remain the only authority. It
accepts only when the project resolves, the provider is known or defaulted
from project memory, the selector is unambiguous against the roster, and a
start carries at least three words of task text; otherwise it declines and
the brain runs as today. Accepted verbs: open, start, follow-up to a uniquely
named or just-opened pane, status, results. Never close, interrupt, answer,
permission or anything on a busy pane. Diagnostics: `request_stage` stage
`compiled` with accepted|declined and the reason.

### 5.2 Voice endpointing and transcription

Adaptive pause: 600 ms when the local turn model reports a complete sentence,
1,200 ms otherwise (`voiceController.cjs`, `voiceTurnModel.cjs`). Early
transcription: at 800 ms of trailing silence the recording so far is sent;
if speech resumes the request is aborted and recording continues; at the
pause the early result is used when nothing was appended. Whisper receives
an initial prompt listing project names, launcher labels and "Lina" so
provider and project names are recognized at the source.

### 5.3 Warm spare pane

Setting "Keep a spare agent ready" (default on): after a start in a project,
ensure one idle unowned pane of that project's default provider exists
(bounded to one per project, only the last active project, closed after 30
idle minutes, never created while the app is under memory pressure). The
resolver already reuses idle unowned panes, so a warm spare makes "open" and
"start" instant with no routing change.

### 5.4 Fidelity harness

A golden-plan corpus: every row of
`scripts/backend/fixtures/orchestrator-utterances.json` gains an expected
plan (verb, project, selector, prompt present, provider). The compiler must
match every row it accepts (precision 100%) and decline the rest; recall is
reported. An opt-in live sweep (`scripts/qa/orchestrator-fidelity-live.cjs`,
about thirty cents) scores the brain on the same rows and writes a
per-release fidelity number the measurement script prints. Written replies
for start and follow-up echo one line of the typed task, unspoken.

Done when: compiler precision 100% on accepted rows with recall at or above
50%; a compiled start request reaches `create_session`/`send_prompt` with
zero model calls; the live-tasks and routing probes stay green; the voice
tests show the adaptive pause and early transcription; a warm spare is
reused by the next start in that project.

## Verification across phases

- Unit: resolver tables from the real utterance corpus; ledger construction
  from receipt fixtures; normalizer tables; transcript shape assertion.
- Live: `scripts/qa/orchestrator-routing-live.cjs --end-to-end` gains
  `send-refused`, `idle-reuse`, `two-similar-titles`, `trust-screen` and
  `retry-created-only` cases. Each costs about one cent.
- Installed: after each release, five spoken requests covering the four verbs,
  with the measurement script's numbers recorded in the release review.

## Decisions carried into this plan

1. An idle pane that owns no task is reusable for new work.
2. The trust prompt is answered automatically for registered projects and
   reported.
3. Ambiguity is resolved by asking with named candidates.
4. Rarely used operations are gated behind mention, then retired if unused.
5. A fallback brain model is a new optional setting for transport failures.

## Sequencing and effort

| Phase | Ships as | Effort |
|---|---|---|
| 0 hotfix | 0.1.118 | 1 to 2 days |
| 1 speed | 0.1.119 | 4 to 5 days |
| 2 memory | 0.1.120 | 2 to 3 days |
| 3 replies | with 0.1.120 | 1 to 2 days |
| 4 scope and measurement | 0.1.121 | 2 days |

The delivery substrate (`orchestratorDelivery.cjs`, `orchestratorLaunchers.cjs`,
`orchestratorTerminalInput.cjs`, `orchestratorTasks.cjs`, the PTY fences) is
kept throughout; it is the tested and correct part of the harness.
