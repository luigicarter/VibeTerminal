# Release 0.1.109 verification

September 9, 2026. This release ships the task-selection repair described in
[the ownership investigation](orchestrator-task-ownership-review.md).

## Local acceptance

- All 49 release gates passed across the initial and resumed runs, including
  1,904 backend/voice tests and 47 frontend tests. Build/type checking passed.
- The background-launch and command fixtures now answer the new selection-review
  protocol using application-provided evidence. Their production validation and
  original assertions remain intact. The hidden command/real-PTY fixture passed.
- One background-launch rerun encountered a proven-unsent stale startup
  observation; its next unchanged run passed. The packaged workspace and close
  fixtures exposed the same assumption that a running PTY meant PowerShell was
  ready. They now wait for the decoded input prompt before their transport test.
  No production readiness or identity checks were relaxed.
- Installer version, blockmap, update-feed size and SHA-512, all fifteen voice
  alerts, fourteen model payload entries and native inference dependencies passed.
- Both packaged voice engines and the packaged workspace/draft/send/setup checks
  passed. Packaged close removed eight original panes, observed four roots and
  four descendants stop, preserved a newcomer and observed no dormant late start.
- Queued-task UI, microphone capture/voice workflow, and history/context tests
  passed. These use disposable application profiles and synthetic audio; they
  do not certify a physical microphone or the user's active agent terminals.
- All 117 files under backend, preload, shared and built renderer matched the
  packaged ASAR. An initial comparison-helper failure was Windows path handling,
  not a package mismatch. The ASAR SHA-256 is
  `b1e8486812e6c7f160c5ff4148aecab39e31e36f18dbac6719f546e18b9ea84c`.

The local installer is 306,412,920 bytes, with SHA-256
`068bfe101792d0eb8ddf2759f64d15fd7546735fd0371d42053d604361a8631c`.
Local logs and package comparison evidence are under `.tmp/release-0.1.109-*`.
GitHub rebuilds the tagged source and repeats the Windows workflow before
publishing its own verified installer; its binary hash can differ from this build.

The previously documented live-model formatting and direct-operator
completion-reporting limits remain. This release does not replay the original
misrouted request or replace the user's saved conversations.

Publication does not replace the running installed app or restart active work.
Installed users apply the release through Check for update, Update and Restart.
