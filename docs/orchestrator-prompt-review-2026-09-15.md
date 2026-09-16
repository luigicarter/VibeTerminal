# Orchestrator prompt and unwanted-terminal review

Reviewed the source checkout, the installed **0.1.124** package version, the saved utterance fixtures, and Ahmed's live profile **read-only**. The user subsequently authorized fixes. Changes are in source; the installed application has not been replaced or restarted. No agent terminal, Electron window, or live-model session was opened for validation.

These repairs subsequently shipped as **v0.1.125**. See [the release review](release-0.1.125-review.md) for hosted native/Electron acceptance, the additional shutdown-persistence repair found during release validation, and verified public installer/update-feed evidence. Publication did not restart the local installation.

## Evidence and incident timeline

Evidence files are under `%APPDATA%/vibe-terminal`: `orchestrator-conversation.json` (compact JSON, line 1), `orchestrator-work-items.json` (line 1), `orchestrator-settings.json`, and `logs/orchestrator-errors.jsonl`. Request IDs below identify records precisely without checking private conversation dumps or credentials into Git. Times are UTC on September 16, which was September 15 evening in Toronto.

| Time | User request / recorded response | What actually happened |
| --- | --- | --- |
| 03:04:33 | “close the terminals … and open a new Codex one … say hi” (`e53978ed…`) | Three close receipts, no opening or prompt receipt; response **“done.”** Scope diagnostic: log line 1690. |
| 03:04:51 | “open a new vibe terminal codex” (`8bcc769b…`) | Five `create_session` validation failures, followed by the relay action limit. Log lines 1727, 1735, 1744, 1752, 1793 and 1863. These rejected attempts did **not** create five terminals. |
| 03:05:07 | “Open a new Codex terminal … prompt it with Hi” (`f3300047…`) | Opened **Open Codex**, and the saved task text included instructions to open a terminal and send Hi instead of just the greeting. It submitted once after a refused stale observation, then hit conversation-binding errors (log lines 1832, 1854, 1870). |
| 03:05:12 | No request for an additional pane | `spare_pane`, `status: created`, `reason: warm-spare`, target `session_ueo4p6r_mu3ippy1` (log line **1788**). |
| 03:07:06 | “get the Codex Terminal that's currently open … to review the issues” (`b9156bb6…`) | Sent the review to that spare. At 03:07:10, another unrequested `warm-spare` was created, target `session_lnm4t1b_mu3is99j` (log line **1983**). |
| 03:08–03:10 | Follow-ups to the same review, then “plan, review and implement fixes” (`b90adbce…`) | The saved work-item store had **two owners for the same pane/generation**. Resolver selected the correct pane (line 2060), but the one-owner guard rejected it (2061). The same rejection recurred for `82c50c08…`. |
| 03:10:27 | Answered the routing question with **“Review Orchestrator issues.”** (`94206ac8…`) | Sent the answer through model interpretation again; it proposed a terminal-answer operation, failing twice with “Answers must be literal text supplied by the identified user instruction.” |

The latter review/follow-up requests did reach the same working pane before the ownership failure. The evidence does not support describing every request as wrong-target routing. Speech transcriptions also contain “and Vibe terminal,” “envir,” and “Hell enough”; the saved text alone cannot establish the exact original audio or blame every error on transcription.

## Findings and implemented fixes

All source paths below are relative to the repository root. Line references point to the repaired checkout.

### 1. High: spare terminals were automatic by default

`apps/desktop/backend/orchestratorSettings.cjs:14` had defaulted the spare setting on, including profiles saved by unrelated settings changes. The live profile explicitly contains `spareAgent: true` at settings line 14. `orchestratorIntegration.cjs:842` calls the keeper after successful creation **and sending prompts**, and its keeper creation callback at line 937 dispatches a real workspace creation outside the user's command grants. This directly explains the two extra panes above; no model hallucination is needed.

**Fixed:** default off, with explicit opt-in persistence. Old default-on profiles migrate to off in memory when loaded by the repaired build; merely reading them writes nothing. The UI agrees with the default. An opted-in spare that someone manually prompts is also permanently released from automatic cleanup, so finishing manual work cannot later cause its pane to be auto-closed. See `orchestratorSettings.cjs:24`, `orchestratorSparePane.cjs:114` and `frontend/components/OrchestratorSettings.tsx:8`.

### 2. High: first conversation-ID discovery created contradictory ownership

The first review's work item `49780987…` had the pane and generation, but no native ID and selection revision **0**. Follow-up work item `391bda85…` had the **same pane/generation**, native ID `01a0a82d-0264-7190-a815-4bcfc3699948`, and revision **1**. The old revision failed `routingBindingMatches`, so `trackManagedTaskOwnership` (`orchestrator.cjs:979`) minted another record. Later assignment correctly found the pane but tripped the other-owner guard at `orchestrator.cjs:1308`.

**Fixed:** retain native selection provenance in `terminalRuntime.cjs:173`; allow only the first **confirmed startup** transition from unnamed revision 0 to identified revision 1 (`orchestratorRouting.cjs:18`); enrich the existing work item, reservation and request binding before reconciliation (`orchestrator.cjs:1496`). Clear, resume, a different generation/launch token, a known-ID change and later selection revisions still fail. A mocked full request followed by another request now retains one owner and sends twice to the same pane.

### 3. High: targeting grammar could create work beside the requested existing pane

The compiler classified “Prompt **the** Codex terminal in Alpha to review the regression tests” as delegation. The reference resolver knew the unique provider pane, but assignment ignored that exact provider match and fell through to “no idle pane” → create. A busy intended pane thus caused a new pane. Separately, scanning the entire payload made “investigate why users cannot **open a new terminal**” look like a launch request. Historical corpus row 18 even encoded this incorrect `new` selector in a test despite its request to use existing terminals.

**Fixed:** existing definite-provider references reuse or clarify instead of creating (`orchestratorResolver.cjs:190`). Target extraction separates recognized recipient clauses from worker payloads (`orchestratorReference.cjs:62`), and reported “tell it to open” text no longer establishes a fresh-worker request. “Use another” / “put it to another” refers to existing choices. Unavailable handles and recently opened panes now ask rather than falling through to creation. Explicit no-creation constraints block assignment's creation fallback. The planner guidance now distinguishes “a Codex” from “the already-open Codex.”

Also fixed a reproduced negation error: answering “**No, do not open a new one**” previously matched the affirmative substring “open a new” and returned `create`. Negative answers now win (`orchestratorResolver.cjs:65`).

### 4. High: a complete request could become a partial plan reported as done

The close/open/greet incident had a valid close grant, so completion proved the proposed plan had executed, not that all clauses of the user request survived interpretation. The creation-purpose check only examined plans that already contained creation/project grants; an omitted opening was invisible to it.

**Fixed:** the explicit close-then-open command shape must retain opening and requested prompting before any effect (`orchestratorInterpreter.cjs:166`). A missing operation enters the existing bounded interpretation-repair path. The deterministic close/stop compiler also declines second commands and deferred conditions rather than accepting a handle and silently discarding the remainder (`orchestratorCommandCompiler.cjs`, stop/close branch). This is a guard for that recognized compound shape, not a claim that arbitrary natural-language completeness is solved.

### 5. Medium: a routing answer was reinterpreted as a terminal answer

The application had already saved candidate pane IDs and their labels, but only consumed the selected answer inside assignment, **after** model interpretation. The exact title reply could therefore fail before it reached the deterministic resolver.

**Fixed:** exact saved-label and ordinal replies continue the one pending delegated grant directly, preserving its objective and operation/permission fields (`orchestrator.cjs:1836`). The selected answer is retained across continuation transfer. Fresh identity and ownership checks still run. Regression tests replay both “the second one” and “Review Orchestrator issues.” without another model call.

### 6. Medium: blank-opening execution invited repeated malformed calls

The five observed errors originated in `authorizeIntentAction`, before adapter dispatch. The advertised creation schema offered optional `text` even for a blank grant whose validator disallowed text. Empty serialized text reproduces the mismatch; the old diagnostic does not retain rejected field names, so the exact fields of those five live calls cannot be proven retrospectively.

**Fixed:** validated model plans consisting only of blank openings execute their frozen grants in code (`orchestratorIntent.cjs:658`), avoiding a second model's reconstruction. Blank-only schemas omit text (`orchestratorToolSchema.cjs:91`); empty optional text is harmlessly removed, nonempty unauthorized drafts still fail, and validation failures state accepted fields. A full mocked model-plan test proves exactly one opening and no execution-model round.

### 7. Medium: handles were parsed but their fast path was disconnected

`createCommandInterpreter` called `decodePlannerCalls` without the context containing handle mappings. “Stop T1” parsed successfully, then silently declined as `decode-failed`. In addition, planner eligibility omitted exact handle/pronoun matches, withholding `operate_terminal` from “Tell T1 …”. The existing compiler tests manually supplied context to the decoder and missed the production seam.

**Fixed:** pass the actual context (`orchestratorCommandCompiler.cjs:548`) and include exact resolved terminals in eligibility (`orchestratorTargetReview.cjs:195`). Multiple handles retain every target; unknown members do not produce a partial compiled command. Explicitly named project scopes bound working/done fan-outs (`orchestratorReference.cjs:327`), and existing-target review uses that same pool.

### 8. Medium: provider and task-payload drift survived planning

The live “new Codex … Hi” request opened Open Codex. Launcher labels overlapped, and a model-supplied launcher could disagree with the provider in the user's target clause. The saved task text also delegated the outer launch instructions to the worker.

**Fixed:** longest launcher labels match first; a plan that substitutes a different uniquely named provider is rejected for repair (`orchestratorPlannerTools.cjs:223`). For the recognized single-worker “prompt it with X” / “prompt it and say X” shape, the payload remains X (`orchestratorPlannerTools.cjs:217`). This preserves Hi instead of delegating another instruction to open a terminal.

## Verification and boundaries

- Final mocked Orchestrator suite plus native selection unit tests: **2,016 passed, zero failures**. Command from `apps/desktop`: `node --test --test-timeout=45000 --test-reporter=spec scripts/backend/orchestrator-*.test.cjs scripts/backend/terminal-conversation-selection.test.cjs`. Local output: `.tmp/orchestrator-review-tests.log` (ignored).
- `npm run typecheck`, `node node_modules/vite/bin/vite.js build`, and `git diff --check` passed. Vite retains its advisory about the existing large renderer bundle.
- Regression coverage includes existing busy-pane reuse, negative answers, payload-versus-target parsing, missing/multiple handles, project-scoped fan-out, provider preservation, literal greeting, compound-plan omission, settings migration, manually used spare cleanup, startup ownership continuity and exact routing-title replies.
- No source test launched a live agent terminal. Terminal effects were callbacks/fixtures; no live-model ladder, installed acceptance run or installer replacement was performed. The running v0.1.124 process and its saved profile were not modified. It can continue to exhibit the old behavior until a repaired build is installed/restarted.
- Existing duplicated historical owner records were inspected but not rewritten in the live profile. The fix prevents that duplication during new first-prompt identity discovery; it does not promise migration of arbitrary already-corrupted histories.
- Remaining design limit: interpretation still depends on a model for ambiguous speech and compound requests beyond the recognized grammar. These fixes address reproduced application failures and the observed message flow; they do not establish perfect prompt understanding across every provider.
