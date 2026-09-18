# Short new panes and launcher routing

Two things went wrong in one session on September 16. New terminals opened about a third of the height they should have, and the Orchestrator opened an **Open Codex** pane for a request that said "Codex", after refusing a status question it could already answer and asking an unanswerable question about a pane that was not there. The pane default now lives in one place and is 520px; the launcher a sentence names is read once, by one rule, and wins over the launcher the Brain planned; the provider's own error sentence now reaches the pane instead of being discarded.

Reviewed the source checkout, the installed **0.1.126** package version, the saved utterance fixtures, and the live profile **read-only**. Changes are in source. The running application is still 0.1.126: nothing here takes effect until a release is published and the installed application is restarted. No agent terminal was opened against a live model to validate these changes; the Electron board smoke was run by the pane-height work and its artifact is cited below.

## 1. Incident timeline

Evidence files are under `%APPDATA%/vibe-terminal`: `orchestrator-conversation.json` (the saved exchange, with request IDs and system receipts), `logs/orchestrator-errors.jsonl` (`request_stage`, `routing_progress` and `orchestrator_error` records), and `open-codex/sessions/2026/09/16/rollout-2026-09-16T14-27-46-01a0ab79-9320-7713-8d61-f8f7799bf835.jsonl` (the Open Codex turn). Times in the files are UTC; the local times below are Toronto, four hours behind.

| Local | Request | What happened |
| --- | --- | --- |
| 14:26:46 | `e1746810…` "What are the status of the terminals currently working in Vibe Terminal Project?" | Memory fast path `no-match`, compiler declined `no-match`, then two contract errors from the Brain's plan — **"Task status must identify an existing request."** (`orchestratorIntent.cjs:360`) and, on the repair attempt, **"Answers must be literal text supplied by the identified user instruction."** (`orchestratorIntent.cjs:206`) — and the reply **"I could not interpret that request."** |
| 14:27:19 | `68f432f6…` "Can you get codex in Vibre Terminal to investigate An error I just got with the orchestrator." | Compiler declined `unknown-provider`; the resolver recorded `decision: ask, selectorKind: provider, candidateCount: 2` and asked **"Which existing Codex pane did you mean in vibeTerminal?"** No Codex pane was open. The two panes in the project were Claude Code. |
| 14:27:39 | `b405ec14…` "A brand new one." | `resolveAnswer` returned nothing for that reply, so the request fell through to creation with the Brain's launcher. `routing_progress/resolver` recorded `decision: create, selectorKind: none, candidateCount: 2` **and no launcher field at all**; the `routing_readiness` records that follow say `provider: open-codex`. **Open Codex 3** opened at 14:27:46. |
| 14:28:31 | — | The Open Codex rollout records `task_complete` with `last_agent_message: null` and `error.message` **"stream disconnected before completion: Provider stream failed."** That sentence is the one `anthropicProtocol.cjs:77` produced after discarding what the provider actually said. |
| 14:34:37 | — | Lina's first word about that turn, six minutes later: **"Open Codex 3 was restarted before I could confirm its result; check the pane."** Nothing in the saved records says who or what restarted the pane. |

The same day, earlier: 03:04:51 "can you open a new vibe terminal codex" and 03:05:07 "Open a new Codex terminal and Vibe terminal and prompt it with Hi." both opened **Open Codex 1**. The stock `codex` CLI was available and configured (rank 1 in the launcher order), so automatic selection would have chosen it.

Three of these utterances are now corpus rows 129, 130 and 131 in `apps/desktop/scripts/backend/fixtures/orchestrator-utterances.json`, with their exact saved text and timestamps.

## 2. Short new panes

*This section records the pane-height work carried out in parallel; the numbers are from that executor's runs and the tree, except where marked.*

**Cause.** `findAvailablePlacement` in `apps/desktop/frontend/components/tiledBoardGeometry.ts` defaulted a new pane's height to a literal `260` (HEAD line 1124, `desiredSize?.height ?? 260`). `App.tsx`'s `DEFAULT_PANE_HEIGHT` was only the fallback used when migrating rows saved by older builds, so editing it changed nothing for new panes.

**Chrome arithmetic** (the constants are verified in the stylesheet; the cell height and the resulting row count are the pane-height executor's renderer measurement): a pane spends 2px of border (`.terminal-pane`, 1px top and bottom, `apps/desktop/frontend/styles.css:1605-1618`), 36px of header (`.pane-header` `min-height: 35px` plus its 1px `border-bottom`, `:1674-1680`) and 14px of surface padding (`.terminal-surface` `padding: 8px 8px 6px`, `:1850-1855`) — 52px in all, so the old 260px default left roughly 208px of xterm, about 12 rows at the measured 15.3px cell height.

**Change.** `DEFAULT_PANE_HEIGHT = 520` now lives in the geometry module (`tiledBoardGeometry.ts:40`) and is what `findAvailablePlacement` reads (`:1126`); the migration constant in `App.tsx` was renamed `LEGACY_PANE_HEIGHT = 260` (`:162`) and is documented as migration-only. `docs/terminal-runtime.md` states the 520px starting height and its clamping.

**Unchanged on purpose.** Region admission still uses `minH` 170 and the same band order, so a third pane can still land in a short gap rather than being pushed below the board.

**Verification.** `scripts/frontend/tiled-board-resize-smoke.cjs` asserts 520 for an empty tall board (`:647`, `:649`), 390 for a 400px board clamped by the 10px board padding (`:652`), and 266 for a gap between two panes (`:655`-`:656`). The pane-split smoke and `npm run build` were run. The Electron board smoke recorded `new-pane-hole` with `height: 266` in the real renderer: `apps/desktop/.tmp/terminal-board-smoke/1789587842626-23064/results.json` (verified here by reading that artifact). **Not verified in the real renderer:** the 520px tall-empty-board case.

## 3. Launcher choice

### The chain that produced Open Codex

1. The interpreter hands the Brain every available launcher as `{kind, label}` (`orchestratorInterpreter.cjs:308`) and the Brain answers with a `kindOfSession`.
2. The resolver's `create()` preferred the Brain's `scope.kindOfSession` over the provider the sentence named (`orchestratorResolver.cjs:107-115` at HEAD).
3. `namedProvider` tested launcher labels case-insensitively, longest first, so a spoken "open codex …" matched the label **"Open Codex"**.
4. The command compiler refused to read such a sentence at all: `ambiguousLauncherHead` declined "Open Codex terminal in X" as `unknown-provider`, and a containment tolerance forgave the resolver reading "Codex" out of "Open Codex" when it did compile.
5. `DEFINITE_PROVIDER` counted a bare `PROVIDER_WORD\s+in\s+` as definite, so "codex in vibeTerminal" pointed at an existing conversation — and with none open, the question it asked had no answer.
6. The zero-candidate question carried no launcher, so the reply "A brand new one." resolved to nothing and creation used the Brain's kind.
7. `deterministicNewTaskRoute` never read the project's remembered default provider (`projectFacts.defaultProvider = "codex"` for vibeTerminal), which `orchestratorCommandCompiler.cjs` and `orchestratorSparePane.cjs` each read separately for their own purposes.
8. The resolver diagnostic recorded the decision and the selector but not the launcher, so the record could not say who chose it.

### The rules now

A launcher name whose first word is the verb every opening sentence uses is read as a name only when a determiner stands in front of it, or when it is written as one token. The same rule decides that its leading "Open" is not a creation verb. One rule, in `orchestratorReference.cjs` (`spokenPattern`, `openPrefixed`, `withoutNamedVerbs`), read by the reference resolver, the assignment resolver, the command compiler and the planner tools.

| Sentence | Reads as |
| --- | --- |
| "Can you open a new Codex terminal in vibeTerminal" | `codex` |
| "open a new vibe terminal codex" | `codex` |
| "Open Codex terminal in vibeTerminal" | `codex` |
| "open codex in vibeTerminal" | `codex` |
| "open a codex terminal in vibeTerminal" | `codex` |
| "open codex web in vibeTerminal" | `codex-web` |
| "open an Open Codex terminal in vibeTerminal" | `open-codex` |
| "open open codex in vibeTerminal" | `open-codex` — the verb slot is already spent |
| "Open Open Codex terminal in vibeTerminal" | `open-codex` |
| "start open codex in vibeTerminal" | `open-codex` |
| "launch open codex in vibeTerminal" | `open-codex` |
| "open open claude code in vibeTerminal" | `claude-custom` |
| "use the Open Codex one" | `open-codex` |
| "open another open codex terminal" | `open-codex` |
| "open-codex terminal in vibeTerminal" | `open-codex` |
| "open fusion terminal" | `fusion` |
| "openfusion terminal" | `openfusion` |
| "get the Open Codex terminal in X to …" | `open-codex`, and not a request to open one |

**Precedence for a new pane**, in one place (`orchestratorResolver.cjs` `create()`): the answer to Lina's own question → the launcher the user said → the launcher the Brain planned → what this project usually starts → the build-wide rank order.

**Two relations, not one.** The provider lexicon now carries both, because one table was answering two questions and getting the same answer wrongly:

- `family` is the **assignment** relation — which panes may stand in for each other. Codex, Open Codex and Codex Web are three separate products with separate conversations, sign-ins and histories, so they are three families: an idle Open Codex pane is never given work that asked for a Codex terminal, and "the Codex terminal" never selects one. Only the same product under another configuration joins a family (`claude-custom` with `claude`, `kimi-custom` with `kimi`). Read by `orchestratorReference.cjs`, `orchestratorResolver.cjs`, `orchestratorTargetReview.cjs`, `orchestratorSparePane.cjs` and `orchestrator.cjs`.
- `tui` is the **binary** relation — which panes run the same command-line program, and therefore which launchers a reader can confuse for one another. Codex, Open Codex and Codex Web share it. It answers exactly two questions: which native slash-command grammar a pane understands (`orchestratorTerminalGuide.cjs`), and whether a launcher the Brain planned is a correctable substitute for the one the user said rather than a different request (`orchestratorIntent.cjs`, `orchestratorPlannerTools.cjs`).

**The spoken launcher wins.** When the Brain's `kindOfSession` differs from the launcher the sentence named, runs the same program, is a supported launcher this build can start, and the sentence named exactly one launcher, the spoken kind replaces it and the grant carries a `launcherOverride`. A planned launcher running a different program is a disagreement about the request, and the planner tools refuse it rather than substituting a provider. The "exactly one launcher" guard comes from `namedProviders(text, launchers)`, which reads every distinct name in a sentence longest-first and blanks each match before trying the next, so "a codex terminal and a codex web terminal" is two kinds and "codex web" is never also "codex".

**The zero-candidate question.** A definite provider reference with no pane of that kind open now asks the one thing left to decide — *"No Codex pane is open in vibeTerminal. Open a new one?"* — and stores the launcher on the question, so "A brand new one." opens a Codex pane with no further interpretation.

**Bare "codex in <project>"** is no longer a definite reference. It names a kind of agent and a project, so it reuses an idle Codex pane or opens one. *Consequence:* with a **busy** Codex pane open, such a sentence now opens a second pane instead of queueing behind it; the old reading queued. One alternative in `DEFINITE_PROVIDER` restores the previous behaviour if that trade is wrong.

**Status questions.** The `status-all` memory template now also matches "what('s|is|are) the status(es) of (the|my|all the) (terminals|agents|panes)", "status (report|update)", "which (terminals|agents|panes) are (currently) working", and "what are (the|my|all the) (terminals|agents|panes) (working on|up to)". The September 16 sentence is answered from the roster with no model call.

**Diagnostics.** `routing_progress/resolver` now records the Brain's `plannedKindOfSession`, the `assignmentMode` it planned with, and the resolver's chosen `kindOfSession`; a correction emits `routing_progress/launcher_overridden` with the from/to pair. These three field names had to be added to the diagnostics allowlist in `orchestratorDiagnostics.cjs:28` — without it the redactor silently dropped them, which was reproduced before the fix.

### Consolidation

| | Before | After | Grep |
| --- | --- | --- | --- |
| Hand-written provider name tables | 4 | 1 | `grep -rn "PROVIDER_PATTERNS = \|PROVIDER_WORD = \|FAMILY_ALIASES = \|PROVIDER_VOCABULARY = " backend/*.cjs` |
| Relation (family) maps | 4 | 1 lexicon (two derived relations) + 1 retained | `grep -rn "PROVIDER_FAMILY = \|PROVIDER_TUI = \|FAMILY_ALIASES = \|const profile = provider\|COMPOSER_FORMS = " backend/*.cjs` |
| Readers of the remembered default provider | 3 | 1 | `grep -rn "\.defaultProvider" backend/*.cjs` |
| Launcher-ambiguity tables in the compiler | 1 | 0 | `grep -rn "ambiguousLauncherHead" backend/ scripts/` |
| Copies of the "how many providers were named" count | 2 | 1 | `grep -rn "mentionedProviders\|namedProviders\|spokenLauncherCount" backend/*.cjs` |

Deleted: `PROVIDER_PATTERNS` and `PROVIDER_WORD` as literals (both now derived from the lexicon), the compiler's `FAMILY_ALIASES` (every row of it was already produced by the `PROVIDER_VOCABULARY` loop two lines below it), the reference resolver's private `PROVIDER_FAMILY`, the terminal guide's provider ternary, `ambiguousLauncherHead` and its call, the compiler's containment tolerance, and the planner tools' own provider count. Added as single sources: `family`/`tui` on the lexicon with `providerFamily`/`providerTui`, `namedProviders`, `rememberedProvider`, and `preferredKind` on `deterministicNewTaskRoute`.

**Retained with a reason:** `COMPOSER_FORMS` in `orchestratorPromptReadiness.cjs:70` is *not* a family or binary map. It maps a launcher kind to a **captured composer screen**: `terminal → shell` and `gemini → qwen` (a Gemini-CLI fork painting the same composer) have no relation equivalent, and `cursor`, `fusion` and `openfusion` are deliberately absent because no composer screen was captured for them. Deriving it from either relation would invent recognizers for those kinds and report `unsupported` for gemini. It stays as it is.

## 4. Open Codex turn errors

**The provider's sentence is now carried.** `anthropicProtocol.cjs` threw a bare `'Provider stream failed.'` on a stream `error` event, discarding the provider's type and message. It now joins them, collapses whitespace, bounds the result to 240 characters and throws `Provider stream failed: <type>: <message>`, keeping the same `Error` class and flow and attaching `providerMessage`. `openCodexAdapter.cjs` surfaces that bounded sentence in its `response.failed` payload, so the pane shows what the provider said; anything that is not a provider sentence still gets the generic line.

**Does Lina learn that the turn ended in an error? Not yet, and the plumbing to make her is larger than this change's cap.**

- The notify hook fires only on success. `run_legacy_after_agent_hook` — the only thing that spawns the notify program with the `agent-turn-complete` payload (`vendor/codex-official/codex-rs/hooks/src/legacy_notify.rs:28-41`) — is called on the success branch of the turn loop (`vendor/codex-official/codex-rs/core/src/session/turn.rs:403-413`). Every `Err(…)` arm, including the generic one that covers a provider stream failure (`:443-450`), emits `EventMsg::Error`, calls `emit_turn_error_lifecycle` and breaks **without** running that hook. `docs/terminal-status-support.md` records Codex's contract as "completion notify", which is exactly this hook.
- **The rollout does carry the error, contrary to the vendored reference source.** In the vendored tree, `EventMsg::Error` is excluded from persistence (`vendor/codex-official/codex-rs/rollout/src/policy.rs:111`) and `TurnCompleteEvent` has no error field (`protocol/src/protocol.rs:1995-2010`). The **shipped** `vendor/open-codex` binary nevertheless wrote `task_complete` with `error.message` in the incident rollout (cited in section 1). The reference tree and the shipped binary are different revisions; the durable record exists in the binary the app runs.
- **What would have had to change** for the pane's turn to end with that sentence, and why it stopped here: the Open Codex adapter is already per pane (`openCodexRuntime.cjs:82-95` stores one adapter per pane id and generation), so a callback from the adapter's catch is three lines. It has nowhere to go. `createAgentTelemetryManager` has no in-process entry point for a provider event — the whole event-application body is inline inside the callback server's `request.on("end", …)` handler in `agentTelemetry.cjs` (roughly lines 3705-3972), and the per-session `launchNonce` it authenticates against is deliberately private (the only in-process escape hatch, `getFusionSessionControl`, is Fusion-only). Making an injection point means extracting that handler body into a named `applyAgentEvent(event, activeSession)`. Second, even with the event delivered, the settlement line would not carry the sentence: `agent-attention` with `state: "failed"` sets `turnState = "failed"` but drops `attention.message` (`terminalRuntime.cjs`, the `agent-attention` case ending at the `s.turnState = …` assignment near line 774), and `orchestratorTasks.cjs:414` reads `session.error`, which nothing in the PTY pipeline ever sets. Both hops, plus the snapshot projection into the Orchestrator's session view, are well past the ~80-line cap, so the status pipeline was left untouched.
- **Stock `codex` panes are a boundary.** The provider stream runs between the real Codex binary and its provider, so Lina has no in-process signal at all; the notify hook is silent on an errored turn; and no recognizer for the TUI's error row exists (`grep "stream disconnected"` over `backend/` hits only `mobileBridgeTerminalPage.cjs:421`, which is unrelated). The rollout's `task_complete.error` is the only evidence, and reading it is not implemented.

## 5. Verification

- `npm run test:orchestrator`: **tests 2586, pass 2586, fail 0** (`duration_ms 19015`). The suite was 2584 before the last two regression tests were added.
- Individually: `orchestrator-command-compiler` 25/25, `orchestrator-reference` 11/11, `orchestrator-resolver` 27/27, `orchestrator-memory` 14/14, `orchestrator-vocabulary` 10/10.
- `npm run test:model-providers`: **26/26**, including the new protocol-level and adapter-level provider-error tests.
- `node scripts/qa/orchestrator-fidelity-live.cjs --compiler-only`: *compiler precision 100% (9/9 accepted of 131 rows); recall 100% of 9 compilable; in a lina mobile workspace precision 100% (13/13), recall 100% of 13; brain not run (compiler-only).*
- Corpus rows **129-131** carry the exact saved text of the three September 16 utterances, read from the live profile; all three are `compilable: false`, confirmed against the real compiler, so precision and recall gates are unaffected. Row **77** ("Bye. hey Open Codex Terminal in Vibe Terminal project.") changed from not-compilable to compilable, with provider `codex`.
- Board smokes and `npm run build` were run by the pane-height work; the Electron `new-pane-hole` artifact was read here.

**Not run:** a live-Brain completion-ladder run, any live model session, and the installed application. The installed build is still **0.1.126**; none of this is in the application the user is running until a release is published and restarted.
