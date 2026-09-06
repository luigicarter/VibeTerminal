# Orchestrator visualization

The Orchestrator navigation button sits directly above Multi mode. It opens a
dedicated pane inside vibeTerminal, showing live sessions as clear-glass bubbles.
Session status is expressed by a label, tinted glass, and a bright colored rim/dot. Violet halos
and expansion independently identify Vibe's current request targets.

## Identity and activity

The dashboard uses the backend session directory for native generation, process
state and live status. Native status uses the same runtime projection as terminal
panes, including pending input, child activity, and observation health. Renderer
status labels are accepted only for the exact generation and revision. Paused placeholders and confirmed dead processes
are excluded; missing observations remain Unknown. Titles follow authoritative
conversation/name metadata before older stored transcript references.

`backend/orchestratorActivity.cjs` owns ephemeral request scopes. Targets enter a
scope only after identity/authorization checks. A relay request retains addressed
targets through its reply; independent direct actions retain them until their own
acknowledgment. Independent scopes survive a new relay request and release
separately. Cancellation/disposal clear scopes, and generation changes permanently
prune old identities. Directory listing and background monitoring do not claim
that every session is being handled.

Multiple expanded targets can belong to one multi-session request or overlapping
direct actions. This is not a new parallel-brain engine: the app-wide model still
accepts one relay conversation turn at a time, while the underlying agents can
work simultaneously. Agent Working status alone never expands a bubble.

## Layout and motion

The layout uses staggered hexagonal rows with bounded eight-pixel offsets,
filling each row from its middle. It reserves space for every bubble at its
maximum size, plus halo, drift, and offset margins. Highlight changes alter
scale, not cell positions. Expansion and
retraction use a 320ms transform transition from the current interpolated size;
rapid retargeting does not remount elements or reset the animation.

Drift uses a separate wrapper with a stable per-session phase/duration and a
three-pixel maximum translation. Offscreen and hidden-page animation pauses;
reduced-motion disables drift/transitions. There is no physics engine or
per-frame JavaScript loop. A single cached static glass texture supplies the
reflections. The asset lives in `frontend/assets/orchestrator-glass-bubble.png`.

Recent user interaction controls initial ordering and mild visual emphasis.
The local bounded recency map records pane selection, throttled keyboard input,
and explicit prompt/answer operations. Agent output and passive reads do not
refresh it. Ordering is frozen for a visit; new sessions append and reopening
can rerank by recency. Text remains unscaled and accessible. Many/narrow sessions
scroll instead of becoming unreadably small.

The terminal workspace remains mounted and keeps its original dimensions under
the dashboard. It is hidden and inert, and hidden panes do not count as visible
for attention acknowledgment. Dashboard selection and project/Multi navigation
restore the existing panes through internal app state, without native OS focus
or global keyboard/clipboard input.

## September 6 deep dive

The reported alignment was the implemented CSS grid: every bubble occupied an
identical row/column slot. Color coding existed, but mostly as a one-pixel rim
and an eight-pixel dot over the same neutral texture. The updated field uses
staggered positions and stronger tinted fills, rims and readable status badges.

The investigation also found independent status correctness bugs:

- Open Fusion's `engine-ready` was ignored, leaving new chats Starting.
- `interrupted` was ignored, leaving stopped turns Working.
- The directory watched `delta`/`text-delta` but missed the hosts' actual
  `assistant-text`/`thinking`. A resolved permission could remain Needs you after
  real work resumed.
- App accepted renderer status labels on generation alone. An older renderer
  revision could therefore override a newer backend observation. This race was
  established from code and a regression fixture; it was not reproduced against
  the user's live sessions.
- Starting, pending input, and provisional responses were all displayed Unknown.
  They now have explicit neutral labels; provisional responses are never called
  confirmed Done, and missing telemetry remains Unknown.

Chat lifecycle projection now tracks unresolved permission/question IDs, including
duplicate raw/normalized events and multiple concurrent requests. Actual work
cannot hide a pending request. Resolutions remove matching IDs; readiness and
interruption follow actual host events. Successful results cannot erase pending
requests, and errors retain their tracking while remaining visibly Failed.

Refresh was present: runtime events schedule publication after 150ms, and a
four-second inventory poll covers both enabled mode and the open dashboard while
disabled. There was no evidence of a missing polling loop.

## Verification

Pure checks exercise sampled widths from zero through 1600px, empty/single/many sessions,
multiple active sets, generation mismatch, status/unknown handling, recency ordering,
drift bounds, long titles and bounded persistence.

The September 6 isolated Electron run at
`.tmp/orchestrator-dashboard-smoke/1788719014017-19700/` passed 28 check groups:
single/two/all active targets, 31 sessions, narrow/wide bounds, readable truncated
labels, smooth intermediate scales, rapid retarget, frozen DOM/order, reduced and
offscreen motion, real pointer/keyboard recency, passive output/read exclusion,
distinct visible status fills, native observation/status transitions, a centered
single session with motion resuming after reopening, and
preservation of main/xterm nodes, runtime generation, board layout and PTY
dimensions. Held reads use the actual core scope/IPC path; provider sessions are
fixtures alongside a real PowerShell PTY.

The renderer task sample used 0.01177 seconds over 2.008672 seconds, about 0.59%
of one core's main-thread task time on this machine. This is not a whole-app or
low-end-hardware benchmark. Physical microphones and authenticated cloud speech
were not exercised by this dashboard test.

The parent inspected normal, two-target, narrow, and single-session screenshots. The harness now
waits for the saved fluid pane geometry before taking preservation measurements
and disables Chromium's occluded-window backgrounding during animation checks.
The initial baseline run failed on an unsettled 100%-to-70% pane measurement;
the settled run passed without changing terminal layout code. Provider status
sequences use isolated fixtures, not authenticated running agents.

`npm run build`, the dashboard/runtime/recency frontend smoke checks, and 23
backend tests across integration, adapter edges, and activity passed. The build
retains Vite's existing bundle-size advisory. Changes are in source and the local
renderer build; this verification does not update an installed release.

The earlier dashboard implementation review found and corrected two other issues: failed valid
voice-settings restarts could leave capture active after the relay switched off,
and new relay epochs could hide still-running independent direct actions. Both
received focused regressions and reviewer reinspection. The parent inspected the
actual changes, results and screenshots in addition to subagent review.
