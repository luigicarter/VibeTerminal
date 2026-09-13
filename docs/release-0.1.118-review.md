# Release 0.1.118 review

Status: unpublished candidate. The tag is retained after a clean-runner fixture
startup failure; [0.1.119](release-0.1.119-review.md) carries the correction and
publication record.

This release collects the pending repository work since 0.1.117: terminal-format
Chats and local recovery storage, the Orchestrator dispatch/memory/voice overhaul,
the opt-in read-only phone bridge, the mobile client, the separate Bun/PostgreSQL
account-server foundation, disconnected account/admin previews, website pricing
and navigation changes, shared branding, tests and engineering documentation.

Only the desktop installer and its updater feed are published by the Windows
release. The account server is not deployed or connected to clients, the account
previews remain disconnected, and mobile store submission is separate work.

## Release-review repairs

- Fixed a real existing-target routing regression: `Send <exact-pane-id>:` could
  be rejected by the deterministic selector even though the user explicitly
  addressed that pane. Exact IDs are now accepted only in the recipient position;
  a different recipient and IDs appearing only inside task text remain refused.
  The focused selection suite passes 39 tests, including the new regressions.
- Updated the scripted test interpreter to read the new compact roster, without
  consulting the fixture's desired executor actions or bypassing production grants.
- Migrated older Electron workspace fixtures from localStorage-only seeding to
  the real durable checkpoint API. Tests still exercise normal startup/reload.
- Updated navigation checks to verify Projects, Chats and Settings together,
  including independently scrollable regions at 1440×960 and 1024×640.
- Updated startup/runtime test contexts for the new phone and chat services,
  checked the Phone settings entry, and verified that the update installer waits
  for the shutdown/save barrier.
- Disabled the optional warm-spare feature only in the fixture that counts
  explicitly requested terminal launches; the spare has its own behavior tests.
- Aligned the Windows CI Node toolchain with the tested Node 24 SQLite API.
- A clean mobile CI installation exposed a mock-server dependency on the
  desktop's installed xterm assets. The follow-up mobile-only commit makes
  those assets explicit mobile development dependencies, removes the implicit
  desktop lookup, and verifies ownership. All 79 mobile tests pass locally
  without skips; the desktop release payload is unchanged by this fix.

## Acceptance record

The release-gate run uses the same `cmd.exe`/npm launch mechanism as
`scripts/qa/release-checks.cjs`. Initial failures and their subsequent fixes are
retained in `apps/desktop/.tmp/release-0.1.118-gates`; the final per-gate summary
is `results.json`. Packaging uses the matching 0.144.0 embedded Codex payload,
separate Open Codex/Codex Web resources, pinned voice resources, the production
renderer and the normal NSIS installer configuration. The local pinned Codex
installation is under `.tmp/codex-release-cli`; the user's global Codex version
is left unchanged.

Repository acceptance also includes:

- Root layout/ownership, website and mobile tests.
- Website production build, mobile TypeScript and Android/iOS bundle export.
- Forty Linux Bun/PostgreSQL integration tests, including real HTTP, restart,
  migration rollback, database outage and PostgreSQL restore cases.
- Eleven account-preview tests plus both preview builds; the tests enforce
  their disconnected status and web-only administration.
- Forty read-only mobile-bridge tests.
- Source/private-file review: generated output and runtime credentials remain
  ignored; no candidate live secret was found in the intended changed sources.

All 59 desktop release gates passed, including rechecks after the repairs above.
The final Orchestrator run passed 2,374 backend tests. The native and Electron
fixtures used isolated data and scripted providers.

The local `LinaTerminal-Setup-0.1.118.exe` is 536,704,077 bytes. The installer,
blockmap and `latest.yml` were generated together; the feed's SHA-512 and size
match the installer. Verification also checked 15 voice alerts and 14 voice
models. All 186 packaged backend/shared/preload files match source.

Packaged acceptance passed voice inference, the Open Codex console/model/turn
flow, the workspace/task interface, pane closure with descendant-process cleanup,
and navigation with project-file preservation. The separate queued-task,
microphone-capture/voice-workflow and paginated history/search interfaces passed.
Hidden UI tests distinguish functional acceptance from screenshot or physical
microphone evidence.

Local logs are under `apps/desktop/.tmp/release-0.1.118-*`. The local installer
passed verification, but the tag workflow did not publish it. The active
`apps/desktop/release` output directory belongs to the current publication
candidate; see 0.1.119 for the final release assets.

## Boundaries

The chat recovery implementation preserves committed chat/workspace state and
acknowledged app-owned drafts. Native unsent TUI input, full native context
backups and some interrupted-send/OS-shutdown edge cases retain the limits in
the [chat implementation record](chat-section-implementation-2026-09-13.md).
Provider fixtures and isolated homes do not certify every live account or CLI
version. Publishing an update does not restart the user's running application;
installation remains the existing explicit Update / Restart action.
