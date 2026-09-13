# Release 0.1.121 review

This is the final publication candidate for the complete pending work in the
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

Earlier records contain the full 59 local release gates, all-app checks and
packaged acceptance. The affected suite, final installer/update feed and clean
GitHub workflow are checked again for this candidate. Public asset and workflow
results will be recorded here once publication finishes.

Unpublished tags 0.1.118, 0.1.119 and 0.1.120 remain unchanged. No candidate's
failed validation is bypassed. Hosted account deployment, preview wiring,
mobile store submission and documented recovery limits remain separate.
Publication does not install or restart the user's running application.
