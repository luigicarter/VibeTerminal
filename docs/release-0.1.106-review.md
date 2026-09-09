# Release 0.1.106 verification

September 9, 2026. This release ships the repairs in
[the current-conversation audit](orchestrator-conversation-errors-2026-09-09.md)
and the completed listening cue described in
[voice push-to-talk](voice-push-to-talk.md).

## Local acceptance

- All 49 release gates passed across the initial and resumed runs, including
  1,889 backend tests and 47 frontend tests. Build/type checking passed.
- The new listening-cue import exposed an outdated mock in the capture-lifecycle
  test. Updating that mock restored its existing assertions; the nine dedicated
  listening-cue tests also passed.
- The hidden background-launch fixture twice encountered the previously recorded
  CDP timeout. Its diagnostic rerun passed all checks and thirty navigation
  transitions. The fixture and its assertions were not weakened. This remains
  a local harness reliability limitation, not proof of a visible-window defect.
- The pinned embedded Codex 0.144.0 was prepared from an isolated local dependency;
  the user's newer global CLI was preserved.
- Installer version, blockmap, update-feed size and SHA-512, all fifteen voice
  alerts, fourteen model payload entries and native inference dependencies passed.
- Both packaged voice engines and the packaged workspace/draft/send/setup checks
  passed. Packaged close removed eight original panes, observed four roots and
  four descendants stop, preserved a newcomer and observed no dormant late start.
- All 116 checked files under backend, preload, shared and built renderer matched
  the packaged ASAR. Its local SHA-256 is
  `36dae6b911a23cf9f622c34bd58ad69f80cb595a2d9414b31d7855637b82d614`.

The local installer is 306,409,261 bytes, with SHA-256
`ee4cace20ddd40083f1443e20959a4abdeac08dd911d1d0a9ff7d59bf3b103a0`.
Local evidence is under `.tmp/release-0.1.106-*`. GitHub rebuilds the tagged source,
repeats the complete release workflow and publishes its own verified installer;
its binary hash can differ from the local build.

Publication does not replace the running installed app or restart active work.
Installed users apply the release through Check for update, Update and Restart.
