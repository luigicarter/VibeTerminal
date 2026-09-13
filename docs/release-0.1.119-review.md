# Release 0.1.119 review

This is the publication candidate for the complete pending work described in the
[0.1.118 review](release-0.1.118-review.md): terminal Chats/recovery, the
Orchestrator overhaul, phone bridge, mobile client, account-server foundation,
disconnected account/admin previews, website changes, shared branding and docs.

## Why 0.1.118 was not published

Tag `v0.1.118` remains on commit `502463c`. Its Windows workflow
[34770338212](https://github.com/luigicarter/VibeTerminal/actions/runs/34770338212)
stopped before building/publishing the installer because the pane-closure fixture
could seed a workspace before the initial renderer bootstrap had checkpointed
its empty state. That later initial write could overwrite the fixture seed on a
clean runner. The diagnostic showed an empty workspace and no dormant panes.
This was not evidence that a user's successfully saved workspace had been erased.

The shared fixture helper now captures its input before bootstrap refreshes
localStorage, waits for the real App shell, yields for the initial checkpoint
microtask, and then commits the fixture snapshot. Two deterministic regression
tests cover the early-write ordering and localStorage refresh cases. The branch
fixture also waits for App readiness before writing its browser storage.

The desktop store also registers the renderer's identity during bootstrap,
before its first save. A later acknowledged writer can therefore retire that
initial renderer and reject a delayed empty checkpoint. A storage regression
verifies this ordering directly, independently of the fixture readiness wait.

Separately, the mobile workflow initially depended on xterm assets installed
with desktop. Commit `e6e12df` adds mobile-owned development dependencies,
removes the implicit desktop lookup and tests independent resolution. All 79
mobile tests pass locally without skips. This change does not alter the desktop
runtime payload.

## Acceptance and publication

The 59 local desktop release gates, 2,374 backend tests, all-app checks and
packaged acceptance for the preceding candidate are recorded in the 0.1.118
review. The follow-up changes cover bootstrap ownership/readiness, mobile
development dependencies and release metadata.
The changed fixtures passed locally, together with 37 chat tests, 67 frontend
tests, the three-process chat/crash/renderer-reload fixture, the 30-pane
two-process resume fixture, branch navigation and pane/process closure.

The local 0.1.119 installer is 536,704,340 bytes. Its SHA-512 and size match
`latest.yml`; verification also checked 15 bundled voice alerts and 14 voice
models. The packaged-source two-process fixture passed for all 30 panes in
`apps/desktop/.tmp/session-resume-smoke/1789320581791-63052`.

Production workflow, final installer/feed validation and publication evidence
will be recorded when those steps finish. No 0.1.118 release assets were
published. Neither this work nor publication installs or restarts the user's
running app automatically.

The existing recovery limits, disconnected-account boundaries and mobile store
submission limits continue to apply.
