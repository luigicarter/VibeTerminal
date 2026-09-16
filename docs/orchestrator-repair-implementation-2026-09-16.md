# Orchestrator clarification and partial-launch repair

Implemented September 16, 2026, following the
[incident review](orchestrator-incident-review-2026-09-16.md) and
[repair plan](orchestrator-repair-plan-2026-09-16.md). Changes are in source and a
local unpacked verification build. The running installation and its profile
were not modified or restarted. Existing unrelated Chats changes were preserved.

## Result

- Unknown direct opening names such as `codical` and `web` now clarify before
  interpretation or creation. The previously pending guard uses the shared
  recipient-clause boundary and request prefix; generic pane descriptions are
  allowed. Known voice aliases still flow through existing normalization.
- Clarification retains the original task and constraints. The user can answer
  with just a corrected provider/count; they need not repeat the objective.
  A mocked continuation verifies one or two requested Codex panes, exact literal
  task preservation and one submission to each. Ambiguous answers retain the
  pending request. Existing cancellation and continuation protections remain.
- Assignment binding now collects every creation outcome. A failed launch or
  invalid binding does not discard a successfully bound independent sibling.
  Failed grant IDs are explicitly excluded from executable targets and delivery.
  Mixed operation plans still stop at assignment failure; request dependencies
  and `afterResults` preserve ordered work.
- Each work item follows its own delivery/result waits. A sibling's failure
  cannot mark submitted work failed; completing that work cannot erase the
  aggregate request's remaining failure. Retry reuses the original recovered
  pane and never revives the submitted sibling. Merely becoming ready sends
  nothing. Cancellation retains late creation receipts without sending tasks.
- Partial requests publish receipt-derived visible and spoken replies with no
  completion cue. Launcher labels survive timeout receipts, and the failure
  composer avoids appending the same exception a second time.
- The routing startup gate reports its actual phase and last blocker instead
  of calling every failure an input-readiness timeout. Diagnostics retain pane,
  request, grant, action, launch token, generation, process/launch state,
  inventory/agent-PID presence and observation class. At most twelve state
  transitions and one final record are emitted per wait, never one per poll.
  Routine startup diagnostics contain no raw screen, prompt or credential data.

Implementation lives in the desktop backend's reference/interpreter, core
assignment/reconciliation, launchers/integration/diagnostics and response modules.
The failed clarification test now checks live state and awaits real persistence
before reading the saved conversation; no timing sleep was added.

## Verification

Commands run from `apps/desktop` unless noted. Local evidence files are ignored.

| Check | Evidence |
| --- | --- |
| Full Orchestrator gate | `npm run test:orchestrator`: **2,570 passed**; final result in `.tmp/repair-final-gate.log`. Covers new mixed success/failure in both orders, invalid binding receipts/generations, successful sibling completion, exact-pane retry, cancellation, dependent work and clarification. |
| Frontend | `npm run test:frontend`: 67 passed. `.tmp/repair-frontend.log`. |
| TypeScript + production renderer | `npm run build`: passed. Existing large-bundle advisory remains. `.tmp/repair-build.log`. |
| Repository boundaries | Root `node --test scripts/monorepo.test.cjs`: 3 passed. |
| Real Brain, real pane | `node scripts/qa/orchestrator-completion-ladder.cjs --tiers 6 --scenario T6.G --budget 0.5`: 2/2 passed, no harmful effects, $0.0048. Real Luna interpretation, isolated real Codex TUI with local model stub. Report directory `.tmp/orchestrator-ladder/2026-09-16T14-09-32-076Z-16420`. |
| Native Codex Web | `node scripts/qa/codex-web-tui-smoke.cjs --pending-login`: real bundled TUI ready in 2,721 ms; native model picker passed. Isolated config/catalog and simulated pending account check, no live model call. `.tmp/repair-codex-web.log`. |
| Command/PTY | Hidden command smoke passed, including real shell output, policy refusals, cancellation and saved-history resume. `.tmp/repair-command3.log`. |
| Background launching | Hidden background-launch smoke passed; creation, send, offscreen/maximized launch, remount and restart. `.tmp/repair-background.log`. |
| Task UI | Hidden task UI smoke passed. `.tmp/orchestrator-task-ui-smoke/1789567523213-35324/results.json`. |
| Packaged UI | Navigation smoke against the local unpacked executable passed: layouts, navigation, live shell and project removal preserving files. `.tmp/repair-packaged-navigation.log`. |
| Packaged backend | Focused routing, readiness, clarification and reference tests: **67 passed**, with backend/shared modules loaded from the new `app.asar`; final result in `.tmp/repair-package-tests.log`. |

The command smoke initially exposed an old fixture mismatch: it gave the
interpretation stand-in internal session IDs while the actual planner roster
contains handles. Commands now use the real handle and the saved conversation's
title; exact resumed-pane ID checks remain. This is a fixture correction, not
evidence that arbitrary internal IDs became a supported user reference. The
navigation harness gained `--app-path` to test the scratch package directly.

The local package was built with `electron-builder --win --dir` into
`.tmp/orchestrator-repair-package/win-unpacked`; no installer was published.
Focused packaged tests use the same test fixtures and a local module-resolution
shim pointing production backend/shared imports at that archive. The packaged
UI smoke runs the actual executable on a separate profile.

## Limits

The original Codex Web failure did not record the missing readiness fact, so
its exact cause cannot be reconstructed. The native TUI passed in isolation;
this does not prove that the installed profile's account/login/process state
will always launch successfully. This repair adds diagnosis and preserves
independent work when startup fails; it does not loosen identity/input guards
or blindly lengthen timeouts.

T6.G adds ambiguity and corrected creation to the real-model ladder. Mixed
launch failures, identity faults, retries and cancellation are covered by
deterministic integration tests; the real-model ladder has no injected startup
fault for them. Existing historical owner records were not rewritten. No live
voice recognition, original audio replay, microphone overlay or external
foreground/clipboard preservation was measured by these hidden checks.

The unpacked build retains the current desktop version for local verification.
The installed v0.1.125 does not acquire these new changes until a future release
is installed and restarted.
