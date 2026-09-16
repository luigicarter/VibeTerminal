# Orchestrator incident review — September 16, 2026

Read-only review of Ahmed's saved conversation, action receipts, work items and
rotated diagnostics, compared with the installed archive and current source.
No live pane was opened, prompted, closed or restarted. Existing source changes
were preserved. This review adds documentation only.

## Current installation and evidence

- Installed `resources/app.asar/package.json` is **0.1.125**. Running Lina
  processes include starts at 08:39 Toronto, after this build's executable
  timestamp (12:29 UTC). This morning's errors cannot simply be attributed to
  still running the previously reviewed 0.1.124 installation.
- Profile: `%APPDATA%/vibe-terminal`. Read `orchestrator-conversation.json`,
  `orchestrator-work-items.json`, and `logs/orchestrator-errors.jsonl` plus its
  rotations. The retained conversation has 26 task records, including older
  unfinished requests; this is not a complete usage sample or a failure rate.
- Installed and source `orchestrator.cjs`, `orchestratorLaunchers.cjs`,
  `orchestratorSettings.cjs` and `orchestratorRouting.cjs` match after newline
  normalization. The interpreter and reference resolver differ because of
  pre-existing, uncommitted changes described below.

## New incident: September 16, 08:56–08:57 Toronto

Request `183aa714-cd42-4495-8cce-4ee3e383fb0c` was saved as:

> Really, no. open a codical terminal and web terminal, and have it investigate
> what else do we need before we can release the app and make it a paid application.

The original audio was not inspected. This establishes what the application
received, not what the user actually pronounced or how many panes they intended.

1. **Unrecognized names became concrete launcher choices.** No normalization
   event appears for this request. The command compiler declined at log line
   2228, and the interpretation model returned successfully. Two explicit-new
   assignments were then reserved (2232–2235): Open Codex and Codex Web. The
   model's exact response body is not retained, but the resulting assignments,
   task label, bindings and receipts establish those choices. The app should
   resolve the uncertain recipient before opening guessed providers.
2. **Codex Web failed the startup confirmation gate.** Open Codex
   `session_cn33qiu_mu43uk9f` returned `created` at 12:56:51 UTC. Codex Web
   `session_n9qsdfo_mu43uk9f` returned `launch-timeout` at 12:57:09 UTC
   (log line 2242). The gate is `waitForRoutingReady` in
   `apps/desktop/backend/orchestratorLaunchers.cjs:39`, with a default 20-second
   timeout. Its error mentions input readiness, but this gate actually checks
   inventory/process/recipient facts; decoded composer readiness is checked
   later. The retained logs do not show which fact was missing, so a login
   screen, process detection problem or slow startup cannot be distinguished.
3. **One failed creation prevented all prompt delivery.**
   `bindTaskAssignments` at `apps/desktop/backend/orchestrator.cjs:1373` awaits
   and binds each creation before execution begins. At line 1386 it throws on
   the failed creation. The live stack identifies this exact location (log
   line 2243). Neither pane received a `send_prompt` action for this request,
   even though Open Codex had already returned success. Both work items became
   failed. This explains the empty opened pane and missing investigation.
4. **The error presentation obscured the partial outcome.** The saved reply
   announces Open Codex, refers to the other pane only as “the terminal”, and
   repeats the timeout sentence. It does not clearly name both panes and say
   that neither received the task.

Immediately before this, closing the specifically named review pane succeeded
(08:55), and the Claude chat-visibility request was submitted and observed
working (08:56). Thus this was not a general inability to open panes or deliver
all prompts. No HTTP/provider error appears in the latest failed request; its
interpretation call returned HTTP 200.

## Earlier failures confirmed in the retained history

These are covered in greater detail by
[the September 15 review](orchestrator-prompt-review-2026-09-15.md).
Times here are Toronto on September 15:

| Time | Confirmed behavior |
| --- | --- |
| 23:04:33 | “Close … open … say hi” closed three panes, omitted opening and greeting, then answered “done”. |
| 23:04:51 | Blank opening hit five action-validation rejections and the relay limit. These were rejected attempts, not five created panes. |
| 23:05:07 | A Codex/Hi request opened Open Codex and sent the outer opening instruction as the task; subsequent actions rejected a changed conversation binding. |
| 23:05 and 23:07 | Two warm-spare panes were created without requests for extra panes. |
| 23:09–23:10 | Follow-ups to the review failed with conflicting task ownership; the exact title answer was then misinterpreted as an answer to a terminal prompt. |

The earlier repair is present in the installed release; publication and test
evidence are in [the 0.1.125 review](release-0.1.125-review.md). Its presence does
not establish that every historical duplicate owner was migrated or that all
speech/compound-request cases are solved. The new morning incident uses a
different path from the old automatic warm-spare behavior.

## Existing pending change and verification

Before this review, the checkout already contained `unresolvedOpeningLauncher`
and an interpreter guard that asks which terminal an unrecognized opening name
means. That guard is absent from the installed archive.

- Ran the two affected test files with Node's test runner. The run failed:
  the new integration test reads `orchestrator-conversation.json` before it
  exists (`ENOENT`). The run is not a passing release gate.
- Separately replayed the exact sentence with a scripted interpreter and
  mocked terminal adapter against an isolated temporary profile. The current
  source asked `Which terminal did you mean by "codical"?`, preserved the
  request as `needs-answer`, and made **zero interpretation calls and zero
  terminal effects**. Evidence profile:
  `%LOCALAPPDATA%/Temp/lina-readonly-audit-fH0wmy`.
- This verifies that narrow guard, not the subsequent clarification answer,
  real speech recognition, actual Codex Web startup, or partial-launch recovery.
  No source fixes were made during this review.

## Recommended repair order

1. Finish and verify uncertain-launcher clarification, including preservation
   of the task when the user supplies the answer; repair the test's persistence
   synchronization before treating it as green.
2. Preserve independently executable work after a sibling launch fails, while
   respecting explicit dependencies and avoiding duplicate prompts on retry.
3. Record the last startup readiness reason with the failed pane's name and
   identity; replay the Codex Web startup failure in an isolated profile.
4. Report partial results once, with each pane named and prompt delivery stated
   explicitly. Keep pane creation, prompt submission and task completion distinct.
