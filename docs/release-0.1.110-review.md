# Release 0.1.110: performance and harness review

This release includes the [Orchestrator overhaul](orchestrator-harness-overhaul.md),
the viewport-based fullscreen correction, and the performance changes below.

## Measured performance problems

Microphone capture, voice routing, interaction checks and readiness polling used
`getState()` to read small control fields. That method serializes and redacts the
whole retained conversation. With 1,500 synthetic messages (3,259,179 bytes) and
24 synthetic panes, the actual coordinator spent about 887 ms on 200 enabled
checks and 412 ms on 100 pending-interaction checks.

Internal `isEnabled`, `getUsage`, `getRequests` and `getTasks` readers now project
only the requested data. Mutable returned data stays detached; questions and task
text retain redaction. Voice compatibility adapters can still use the old API.
The same two loops took 0.25 ms and 0.33 ms after the change. This measures local
control work, not model latency or a whole-application speed multiplier.

Unchanged inventory refreshes also rebuilt, persisted and published the full
history. Equality checks now suppress that publication while still reconciling
waiting tasks, observed completions and expiring context. Refresh returns a
detached session projection without building a second full snapshot. Forty
unchanged refreshes fell from 609 ms/40 publications to 1.7 ms/zero publications;
all ten changed observations still published, and every retained message survived.

The real Electron/preload test exposed an additional unconditional publication
when a direct read-only action released an empty activity scope. Scope release
now publishes only when targets actually leave the activity display. Errors and
action receipts still publish through their ordinary paths. With the same large
history and a real idle PowerShell pane, 40 UI inventory round trips fell from
596 ms to 73 ms; renderer task time fell from 225 ms to 16 ms and state broadcasts
fell from 40 to zero. This is a controlled local comparison, not a production
latency or frame-rate guarantee.

Evidence:

- `.tmp/orchestrator-performance/1789011231107-44648/` — initial coordinator timings and CPU profile.
- `.tmp/orchestrator-performance/1789011298359-42756/` — narrow-reader/refresh timings and CPU profile.
- `.tmp/orchestrator-navigation-smoke/1789011574916-17976/` — Electron polling before activity-scope correction.
- `.tmp/orchestrator-navigation-smoke/1789011656979-42584/` — Electron polling after correction, full history retained.

`node scripts/qa/orchestrator-performance-bench.cjs` reproduces the offline
coordinator measurement. `node scripts/qa/orchestrator-navigation-smoke.cjs
--performance` adds the large-history measurement to the real desktop smoke.
Timing thresholds are deliberately not CI assertions; behavioral invariants are.

## Review scope

Review covered the planner/tool decoder, purpose and recipient checks, scoped
workspace executor, model retry/accounting, inspection evidence and completion,
partial project removal/retry, app navigation, current-state readers, and the
fullscreen changes. Project removal has no filesystem deletion adapter. Read
recovery stays source-bound; model transport retries cannot replay terminal input.

The fullscreen desktop check measures both a 1,200-pixel and 640-pixel window,
confirms the tall pane exceeds the former 720-pixel cap, and verifies that restoring
the pane preserves the saved layout. All 12 views and real project removal/re-add
are exercised with a preserved marker file and unrelated running terminal.

Release preparation found outdated source-shape expectations in the attention
and workspace smokes and a background-launch model fixture missing the new blank
creation purpose response. These were updated to the shared observed-close and
planning contracts. Production validation was not relaxed to satisfy the fixtures.

The review also closed two purpose-validation gaps: a `DRAFT` judgment is invalid
for a creation with no draft text, and an informational inspection cannot satisfy
the executable-task requirement after a rejected draft. Both have regressions
showing that no terminal effect escapes the veto.

A subsequent live-model run proposed only `add_project` for an add-project-and-task
request, then exhausted execution rounds without creating a worker. Project-only
plans now receive the same bounded purpose review before any effects. A missing
task consumes the semantic repair allowance and requires a complete project/task
plan; an ordinary add-only request remains supported. Two deterministic regressions
cover both cases. The failing evidence remains under
`.tmp/orchestrator-recovery-live/1789012006024-26644/`; the current natural request
passed with one add, one creation and one submission in five model calls under
`1789012162295-2008/`. This is not a claim that every model wording will succeed.

## Acceptance

- All 50 local release gates passed across the initial and resumed runs. After
  the final purpose-review corrections, all 1,966 backend/voice tests passed again
  with no failures or skipped tests. The full frontend suite passed all 53 tests.
- Build and type checking passed. The hidden command/preload/real-PTY check also
  passed, including stale-recipient refusal and exact saved-conversation binding.
- Current live-model recovery passed the two-initial-error scenario with one
  worker and one submission in six live calls; evidence is under
  `.tmp/orchestrator-recovery-live/1789012006005-57144/`.
- The local installer and update feed passed version, size, SHA-512 and blockmap
  verification; all 15 voice alerts, 14 model payload entries and inference
  dependencies verified. The build used the locally cached pinned Codex 0.144.0
  payload, leaving the newer global installation unchanged.
- Packaged voice inference, workspace/draft/send/setup, process-close, all 12
  navigation destinations and project file preservation passed. Close verified
  four roots and four descendants stopped, eight original panes removed, a
  newcomer preserved and no dormant late starts. The packaged navigation test
  also passed both fullscreen dimensions and saved-layout restoration.
- Queued-task UI, real Electron capture with synthetic audio, microphone stall
  recovery, and history reconstruction passed. Navigation screenshots are now
  opt-in: the first packaged attempt stalled on a hidden-window screenshot, while
  its final DOM/geometry/effect run passed in
  `.tmp/orchestrator-navigation-smoke/1789012475174-58684/`.
- All 132 backend, preload, shared and built renderer files matched the packaged
  ASAR. An initial comparison helper used the wrong path separator for Windows
  ASAR lookup; the corrected native-path comparison found no mismatches.

Local installer size: 306,438,687 bytes. SHA-256:
`fe55f333644dbe37fb186783e1a5c9f57f8aad08871e18b48bf0eddfc345bd4d`.
ASAR SHA-256:
`2ebfd2212e8a8d5e22a96e035012dba31cebdbc0969588cd411b9d3f36f63558`.
Logs and comparison evidence are under `.tmp/release-0.1.110-*`. GitHub rebuilds
the tag and repeats the full Windows workflow before publishing, so its binary
hash can differ from the local build.

## Release boundary

Tests use disposable application profiles, synthetic audio and model/native
fixtures where stated. They do not certify physical microphones, every external
provider menu/version, or arbitrary coding results. The existing Vite chunk-size
advisory is separate from the measured control-path bottleneck.

Publishing makes the installer and update feed available. The user's installed
processes, saved conversations and native terminals are not restarted by publication.
