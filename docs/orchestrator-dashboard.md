# Orchestrator visualization

The Orchestrator navigation button sits directly above Multi mode. It opens a
dedicated pane inside vibeTerminal, showing live sessions as clear-glass bubbles.
Session status is expressed by both a label and a colored rim/dot. Violet halos
and expansion independently identify Vibe's current request targets.

## Identity and activity

The dashboard uses the backend session directory for native generation, process
state and live status. Renderer metadata enriches project names and status labels
only when generation matches. Paused placeholders and confirmed dead processes
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

The layout reserves space for every bubble at its maximum size, plus halo and
drift margins. Highlight changes alter scale, not cell positions. Expansion and
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

## Verification

Pure checks exercise widths from zero through 1600px, empty/single/many sessions,
all active sets, generation mismatch, status/unknown handling, recency ordering,
drift bounds, long titles and bounded persistence.

Real isolated Electron evidence at
`.tmp/orchestrator-dashboard-smoke/1788648903943-33860/` passed 25 check groups:
single/two/all active targets, 31 sessions, narrow/wide bounds, readable truncated
labels, smooth intermediate scales, rapid retarget, frozen DOM/order, reduced and
offscreen motion, real pointer/keyboard recency, passive output/read exclusion,
and preservation of main/xterm nodes, runtime generation, board layout and PTY
dimensions. Held reads use the actual core scope/IPC path; provider sessions are
fixtures alongside a real PowerShell PTY.

The renderer task sample used 0.014173 seconds over 2.004669 seconds, about 0.71%
of one core's main-thread task time on this machine. This is not a whole-app or
low-end-hardware benchmark. Physical microphones and authenticated cloud speech
were not exercised by this dashboard test.

Independent review found and corrected two issues before release: failed valid
voice-settings restarts could leave capture active after the relay switched off,
and new relay epochs could hide still-running independent direct actions. Both
received focused regressions and reviewer reinspection. The parent inspected the
actual changes, results and screenshots in addition to subagent review.
