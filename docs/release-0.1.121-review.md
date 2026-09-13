# Release 0.1.121 review

This is the published release for the complete pending work in the
[0.1.118](release-0.1.118-review.md), [0.1.119](release-0.1.119-review.md) and
[0.1.120](release-0.1.120-review.md) records: terminal Chats/recovery, the
Orchestrator overhaul, phone bridge, mobile client, account-server foundation,
disconnected account/admin previews, website updates, shared branding and docs.

## Windows memory-save repair

The first 0.1.120 CI attempt passed the startup and compact-sidebar checks, then
timed out in one pane-memory integration test. An unchanged rerun was started
while investigating. A six-worker, 30-run local reproduction then failed twice.
Retained diagnostics showed that the result was correctly summarized and shown,
but a Windows `EPERM` refused the atomic replacement of
`orchestrator-agents-v1.json`, leaving the old persisted memory record. The
unchanged CI rerun was cancelled before it could publish that known issue.

The agent store now retries only `EPERM`, `EACCES` and `EBUSY` for atomic primary
and backup renames, with five bounded backoffs totaling 620 ms. It never deletes
the last good destination to force progress. Permanent failures still reject
the write and keep the prior on-disk and in-memory store state. Regression tests
cover transient primary/backup locks and the bounded persistent-lock failure.

After the repair, all 30 six-worker stress runs passed. The focused agent-store
and pane-memory group passed 16 tests. Evidence is under
`apps/desktop/.tmp/pane-memory-stress*.json` and the retained failure diagnostics
identified by `.tmp/pane-memory-stress-failure-*.log`.
The complete affected Orchestrator suite also passed all 2,376 tests after the
repair (`.tmp/release-memory-lock-fixed-suite.log`).

## Acceptance and publication

Earlier records contain the full local release gates, all-app checks and
packaged acceptance. The final
[Windows workflow](https://github.com/luigicarter/VibeTerminal/actions/runs/34774152446)
succeeded for commit `1451e78` and release tag `v0.1.121`. All 59 release gates passed on the clean runner,
including 2,376 backend tests and the repaired pane-memory persistence case.
Installer/feed validation, packaged voice/Open Codex/workspace/closure/navigation
checks and the additional task, voice and history UI checks all passed before
publication.

GitHub published [v0.1.121](https://github.com/luigicarter/VibeTerminal/releases/tag/v0.1.121)
on September 13, 2026 at 18:33:54 UTC with the installer, blockmap and `latest.yml`.
The downloaded public installer is 536,621,735 bytes; its SHA-512 and size match
both feed entries. An unauthenticated request to the public latest-update feed
returned HTTP 200 and the same version/hash. GitHub's latest release resolves to
v0.1.121. Local verification evidence is
`apps/desktop/.tmp/public-release-0.1.121/verification.json`.

Unpublished tags 0.1.118, 0.1.119 and 0.1.120 remain unchanged. Their failed
validation was not bypassed. Hosted account deployment, preview wiring,
mobile store submission and documented recovery limits remain separate.
Publication does not install or restart the user's running application.
