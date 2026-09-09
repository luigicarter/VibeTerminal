# Release 0.1.104 review

The September 8 review covered the pending Lina rename, Orchestrator routing,
queueing, startup/input handling, model compatibility, voice, renderer changes,
and Windows release configuration. The reported terminal-wheel problem was
included. Confirmed defects were fixed and reviewed again; an independent
integration sweep found an additional routing defect, which was also repaired.
The final reviewed scope has no remaining confirmed software defects.

## Repairs

| Trigger | Repair and regression coverage |
| --- | --- |
| Wheel input while viewing history with TUI mouse tracking, exited panes, or delayed viewport events | Local history keeps wheel ownership; Shift-wheel reaches history from a live TUI; upward scrolling clears follow-tail immediately. The actual pane handlers and xterm pass 18 Electron checks. Native TUI scrolling remains supported. |
| Complete-looking tool arguments in a failed provider response | Both command interpretation and task routing reject unsuccessful finish reasons before granting effects or returning assignments. |
| Free-terminal selection sees idle chat state during startup or process failure | Contradictory engine/process readiness prevents Fusion and Open Fusion selection. |
| An idle/completed foreground turn still has a question or approval pending | Readiness watches continue waiting until the interaction resolves. |
| A PowerShell directory is named “Input disabled”, “Do you trust”, or “Connecting to server” | Native-agent onboarding checks no longer reject a verified empty shell prompt. |
| Similar names activate Hey Lina, or a rejected name interferes with the next wake | Wider keyword decoding, bounded companion recovery, and local candidate verification distinguish the tested phrases while retaining quiet/fast wake coverage. See the [voice review](orchestrator-voice-deep-dive.md). |

The board smoke also used an obsolete child-lifecycle protocol. Its fixture now
checks native child events, provisional stops, and explicit child termination;
production lifecycle rules were preserved.

## Local acceptance

- `node scripts/qa/release-checks.cjs`: all **49 checks passed**, including
  **1,674 backend tests**, frontend checks, native speech, and Electron board and
  wheel tests. Board and wheel checks now gate releases.
- The full speech matrix passed **138 positives, 114 negatives, 48 recoveries,
  four spaced phrases, and four old-wake replay cases**.
- An independent lifecycle replay processed **400 clips / 16.45 minutes of
  audio**, with **200 correct wakes, zero misses, and zero false wakes**. Sampled
  RSS peaked at approximately 249 MB and fell to 80 MB after disposal. A separate
  1,200-clip resource stress run also showed natural collection and bounded RSS.
- Production TypeScript/Vite build and Windows NSIS packaging passed.
- Installer/feed SHA-512, size, blockmap, all 14 voice assets and native runtime
  files verified. Packaged voice helpers and the packaged workspace/PTY smoke
  passed; packaged inference startup measured 2.74 seconds locally.
- Real Chromium capture with a synthetic microphone passed wake, push-to-talk,
  repeat capture, interruption/recovery, playback and teardown checks. History
  pagination and exact Unicode reconstruction also passed.
- Changed CommonJS syntax checks and `git diff --check` passed.

Local logs and temporary evidence are under `.tmp/repo-review-20260908` and
`output/voice-handsfree`; they are excluded from the release and Git history.
GitHub's Windows release workflow separately repeats its publication gates.

## Boundaries

These are source, synthetic-audio, isolated Electron and packaged-runtime checks.
They do not establish physical-microphone accuracy, all possible accents/noise,
older-PC performance, or live paid-provider behavior. Very quiet speech with a
long pause inside the greeting remains outside the certified acoustic range.
No existing installed workspace was restarted or upgraded during validation.
