# Release 0.1.124 review

This release publishes everything left uncommitted after v0.1.123: the
Orchestrator's one-terminal-model overhaul (handles, one reference resolver,
compiler-owned stop/close/follow-up, fan-out in code, pane ownership), the
completion-ladder harness and the seventeen app defects it found, the Codex
0.154 idle-sparkle input-surface fence with `tui.whimsy=false`, the Kimi 0.42
status and fork refresh (already committed as `00d6862`), the chat store's
shutdown-intent run marker, and the prepared but disconnected account modules
for desktop, website and server. Those bodies of work carry their own records:
[the overhaul](orchestrator-terminal-model-overhaul-2026-09-15.md),
[the ladder](orchestrator-completion-ladder-2026-09-14.md),
[the sparkle fence](codex-idle-sparkle-and-input-fence-2026-09-13.md),
[the whimsy switch](codex-idle-sparkle-whimsy-override-2026-09-13.md),
[Kimi 0.42](kimi-0.42-status-and-fork-refresh-2026-09-13.md) and
[the account readiness note](account-paid-readiness.md). This file records
only what the release gate found on top of them and the evidence of
publication.

## Repairs found by the release gate

Neither repair touches product code. Both are test fixtures that the work of
this cycle left speaking a retired contract, and both were missed for the same
reason: the overhaul and the sparkle fence were gated on `npm run
test:orchestrator`, and neither file is in that suite.

### 1. An input action with no captured input surface

`scripts/backend/terminal-conversation-selection.test.cjs`, "pending selection
blocks automated keys and mid-observation switching prevents writes", failed
its second assertion: expected `recipient-unavailable`, got `invalid-action`.
The test had been edited this cycle to drop the retired `observationSequence`
and `inputRevision` fields from its operator action, but no `inputSurface` was
added in their place. Since the sparkle-fence consolidation every input action
must carry the surface the application captured at its own last read of the
pane, so `backend/orchestratorTerminalInput.cjs` refused the action at
admission, before the pending-selection rule the test exists to check. The
file runs under `smoke:backend:terminal-runtime` and `test:chat-resume`, not
under `test:orchestrator`.

The action is now built through `scripts/backend/orchestrator-input-fixture.cjs`,
the one place a test builds input evidence, off the same `projectInputSurface`
production uses. The file passes 11 of 11 alone and the release check passes.

### 2. A scripted Brain that still addressed panes by session id

`smoke:electron:orchestrator-background-launch` failed its first command into a
freshly created shell pane: the app replied "I couldn't do that in Terminal 1"
with the `send_prompt` receipt `rejected`, "This effect needs one matching user
command grant." The request log showed the compiler declining
(`unknown-provider`, as expected for a plain shell), one interpretation call,
then execution with `grants: []`.

The smoke sends `Send <session id>: <payload>` and scripts the Brain with
`scripts/backend/orchestrator-test-intent.cjs`, which resolved that recipient
against ids in the roster. Since the overhaul the planner's roster names panes
by handle (`T1`, `T2`, ...) and carries no ids, so the scripted plan came back
with no actions, the app compiled no grant, and the stub's queued `send_prompt`
was rightly refused. Replaying the failing request's own planning context
(from the smoke's `model.jsonl` trace) through the helper reproduced the empty
plan directly; the application's behaviour was correct throughout.

The helper now treats a roster row as a session under its handle and returns
`handles` for an action aimed at it, which `decodePlannerCalls` turns back into
ids exactly as it does for a real Brain, and the smoke addresses the pane by the
handle it reads from the app's own state. The smoke passes end to end. The
helper's unit test and the 2,542-test suite, which uses the helper in fourteen
files, stayed green, and `smoke:frontend:voice-experience` (the other gated
user of the helper) passed after the change.

Two manual scripts outside the gate still speak the old forms and will need
the same treatment when next run: `scripts/qa/orchestrator-command-smoke.cjs`
(`Send <id>:`) and the live QA probes that still mention `observationSequence`
(`orchestrator-live-tasks.cjs`, `orchestrator-conversation-live.cjs`,
`orchestrator-latency-bench.cjs`).

## Acceptance evidence

Local, on `039c5b1` at version 0.1.124:

- `npm run build` (typecheck plus renderer build) passed before the gate.
- `scripts/qa/release-checks.cjs` is fail-fast, so it ran in three segments as
  the two repairs landed: checks 1–23 in the first run; check 24
  (`smoke:backend:terminal-runtime`) alone after repair 1; checks 25–30 in the
  second run; check 31 (`smoke:electron:orchestrator-background-launch`) alone
  after repair 2; checks 32–59 in the third run, ending with
  `test:orchestrator` at 2,542 of 2,542. Every one of the 59 checks passed on
  the tree that was committed.
- The three Electron smokes CI runs beyond the local gate were run locally in
  their unpackaged form and passed: `orchestrator-smoke.cjs --hidden`,
  `smoke:electron:voice-experience -- --hidden` and
  `smoke:electron:context-history -- --hidden`. The packaged variants and the
  installer build itself were left to CI.
- The 70 new files were scanned for credential patterns before staging; the
  only matches were the synthetic Stripe keys in the server's prepared tests.

## Publication

- Commit `039c5b1`, tag `v0.1.124`, pushed to `main` on 2026-09-16 01:33 UTC.
- CI: [run 35044553845](https://github.com/luigicarter/VibeTerminal/actions/runs/35044553845).
- The run completed successfully at 2026-09-16 01:53 UTC, about twenty minutes
  after the push; every step succeeded, including the packaged Open Codex,
  workspace, closure, navigation, task-interface, voice and history checks.
- GitHub release `v0.1.124` was published at 01:53:08 UTC, neither draft nor
  prerelease, with three assets: `latest.yml` (359 bytes),
  `LinaTerminal-Setup-0.1.124.exe` (533,241,136 bytes) and its blockmap
  (533,868 bytes).
- The public update feed `releases/latest/download/latest.yml` resolves to
  version 0.1.124 with that size and SHA-512
  `tb/GzzlQzwQWaQmJcuKQEArJM6MUudhquS+3woa0/boZLxUP4GJ0mzG081aI3d1mVDtOJOgBLfjZYrk9/bcJJA==`;
  the installer downloaded from the release hashed to the same value.
- Installed applications discover the release through that feed and apply it
  through their own Update / Restart action.
