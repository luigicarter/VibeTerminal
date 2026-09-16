# More forgiving voice pause — September 16, 2026

Implemented after the [cutoff analysis](voice-cutoff-analysis-2026-09-16.md).
Source changes only; no release, installer replacement or restart of the user's
running app. The earlier Orchestrator and unrelated Chats changes are preserved.

## Behavior

- Automatic capture defaults to **1,500 ms** of classified quiet after a
  complete-turn prediction. The 600 ms confidence shortcut has been removed.
- **Pause before sending (seconds)** in Orchestrator & voice settings allows
  1–3 seconds. Backend validation rejects malformed/out-of-range saves atomically;
  missing or invalid saved values use 1,500 ms without rewriting files on load.
- The preference is captured per recording. Changing it takes effect on the
  next recording, including spoken answers, without shortening the active one.
- Early transcription at 800 ms stays speculative. Resumed speech invalidates
  its result, including a response that already arrived. Only the current full
  speech revision may reach the Orchestrator.
- Three-second uncertain-completion fallback, queued-VAD/capture identity checks,
  manual hold/release, and explicit click-to-send behavior are retained.

The shared `voiceEndpointing.json` defines the default, bounds and transcription/
fallback timings for the backend and renderer. `voiceConfig.cjs` owns validation;
the settings store persists `voicePauseMs`. `voiceController.cjs` captures it at
turn start and no longer derives a shorter deadline from confidence. The React
settings panel displays seconds and saves milliseconds through the existing API.

## Verification

- **2,579 Orchestrator/native/voice tests passed** (`npm run test:orchestrator`,
  `.tmp/voice-pause-suite.log`). The focused voice/settings run passed 342 tests.
- New regressions reproduce falsely confident 600, 700, 1,000 and 1,200 ms
  thinking pauses, followed by more speech in the same recording and one final
  submission. Tests cover 1,000/2,300/3,000 ms configured boundaries, preference
  changes during capture, disk migration/validation, discarded early transcripts,
  spoken answers, held/manual capture and queued classifications.
- **67 frontend tests**, TypeScript and the production renderer build passed.
  The existing large-bundle advisory remains. Evidence:
  `.tmp/voice-pause-frontend.log`, `.tmp/voice-pause-build.log`.
- Real-model offline voice workflow passed delayed command, **one-second
  mid-command pause**, and wake-only scenarios. Both commands finished at 1,500
  ms quiet. The final upload includes the last audible synthetic clause, and
  each command reaches the mocked relay once. The actual semantic scores at
  their final pauses were approximately 0.984 and 0.931.
  Evidence: `.tmp/voice-pause-workflow.log`.
- Real Electron navigation/settings smoke passed: default 1.5 seconds, numeric
  2,300 ms saved through IPC, and 2.3 seconds restored after panel remount.
  This no-key fixture exercises local persistence and rendering, not the form's
  cloud connection check. Evidence: `.tmp/voice-pause-settings2.log`.
- Hidden Electron voice-experience smoke: **19 checks passed**, using actual
  Chromium microphone capture of synthetic speech with a one-second clause
  pause and real local wake/VAD/completion helpers. Covered Space hold/release,
  automatic capture, second wake, click Send/flush, capture recovery and teardown.
  Cloud transcription/speech were scripted and audible playback muted.
  Evidence: `.tmp/voice-experience-smoke/1789572793247-43220/results.json`.

Older tests that deliberately required 600/1,200 ms completion now use the new
deadline; full-waveform assertions also account for the retained extra quiet.
The offline workflow permits discarded speculative uploads while still requiring
exactly one final relay submission and preservation of the last audible clause.

## Boundaries

Synthetic audio and mocked detector scores establish controller behavior, not
physical microphone recognition quality. Quiet words misclassified as silence
can still be missed; this change does not alter the VAD model, gain or wake-word
detector. At the configured deadline capture still commits, so pauses longer than
that setting may require a longer preference or a held Space recording.

The installed v0.1.125 still uses the old timing until these source changes are
included in a release and the application is updated/restarted.
