# Release 0.1.117 review

This release combines the de-serialized Orchestrator harness, bundled-ConPTY
terminal panes, Codex Web Work routing with response-model verification, the
packaged Open Codex launcher repair, the redesigned voice indicator with its
Stop control, and the removal of the in-app version switcher. It ships every
change that was still uncommitted after the previous release, including the
Orchestrator work described in
[the de-serialization plan](orchestrator-deserialization-plan-2026-09-11.md),
the terminal repair in
[the cursor flicker investigation](codex-cursor-flicker-2026-09-11.md), and the
Codex Web routing described in
[response-model verification](codex-web-model-verification.md).
The previous public release was 0.1.116.

## Repairs found during release review

- Composer-acceptance evidence mis-fired when a prompt's first 48 characters
  wrapped mid-token in the terminal: the wrapped rendering no longer matched
  the probe, so the code concluded the text had left the composer and reported
  a prompt still sitting in the composer as accepted, which also suppressed the
  later unconfirmed-start report. The comparison now ignores whitespace, and a
  regression reproduces the wrapped rendering.
- The model-call retry loop counted every one-shot repair against a
  three-attempt budget, so three legitimate repairs in one call could exhaust
  it and fail a request that was still recoverable. The cap now allows every
  repair, and a regression exercises the three-repair sequence.
- The ConPTY host smoke slept a fixed 2.5 seconds before reading the spawned
  process tree and failed under load. It now polls for the tagged foreground
  child the pane spawned, and fails only when the wait genuinely elapses.
- The documentation index still described the de-serialization plan as
  unimplemented after packages 1 to 8 landed. The index entry now matches the
  implemented state.
- Intermittent failures in the release-check runner were traced to the local
  runner's own process kills, not to product behavior: the Codex Web chain
  passes standalone and again inside the same spawn mechanism when it is not
  killed.

## Acceptance

`tsc --noEmit` is clean, `node --check` passes on every backend, shared, preload
and script `.cjs` file, and `git diff --check` reports no whitespace errors.
The orchestrator suite passes 2,166 tests, including the two new regressions
above; Codex Web passes 78, Open Codex 16, the frontend 59, terminal status 110,
and the new feature tests for this release 23. A targeted post-fix run covering
the repaired paths passes 103. All 57 gates of `scripts/qa/release-checks.cjs`
passed, run in six sequential batches through the same `cmd.exe`/npm spawn
mechanism CI uses.

Packaged verification: the local 0.1.117 installer was built with the release
procedure (matching Codex 0.144.0 payload, Open Codex, Codex Web and voice
resources prepared, `tsc --noEmit`, renderer build, electron-builder).
`LinaTerminal-Setup-0.1.117.exe` is 536,490,517 bytes and `latest.yml`
carries its SHA-512 and size; `scripts/qa/verify-release-artifacts.cjs` passed
(update feed and 15 bundled voice alerts). All six embedded Codex payload files
are present, and all 167 packaged backend and shared files match the source
tree. Against `release/win-unpacked`, the packaged Open Codex console smoke
(PowerShell launch, input, /model switch, fixture turn, Ctrl+C exit, lifecycle
telemetry, catalog cleanup), packaged voice inference, the packaged workspace
and task interface, pane closure with process termination, and navigation with
project-file preservation all passed.

Production publication: the
[Windows production workflow](https://github.com/luigicarter/VibeTerminal/actions/runs/34685749385)
succeeded for commit `dc7b7a4` and tag `v0.1.117`; all 57 release checks and
every packaged verification, including the new packaged Open Codex console
smoke, passed on the runner. GitHub published the
[release](https://github.com/luigicarter/VibeTerminal/releases/tag/v0.1.117)
on September 12, 2026 at 09:42 UTC with the installer, blockmap and
`latest.yml`. The downloaded public installer is 536,490,361 bytes and its
SHA-512 and size match the published feed. GitHub's latest release resolves to
0.1.117. The tag was pushed by the user after this session's automation was
refused permission to push it.

## Boundaries

Native and Electron fixtures run against isolated homes and local model
endpoints, so they do not certify every live provider or account combination.
Live provider and live ChatGPT behavior is verified only where the linked
documents say so, including the Astra Work session evidence in
[response-model verification](codex-web-model-verification.md) and the per-host
byte captures in
[the cursor flicker investigation](codex-cursor-flicker-2026-09-11.md).
Installed applications pick this release up only after the user's
Update/Restart action; publication does not restart an active workspace.
