# Voice push-to-talk (September 5, 2026)

Space push-to-talk is the default voice gesture. Optional [hands-free voice](voice-handsfree.md)
adds "Hey Vibe" activation and automatic completion while retaining this gesture.

## The gesture

- **Hold Space** anywhere in the workspace to record, **release** to send. The
  transcription, relay and spoken reply are unchanged from the wake-word flow.
- Space is ignored when the event target is inside a terminal pane
  (`[data-pane-id]`), an `input`, `textarea`, `select`, an element with
  `role="textbox"`, or anything contenteditable. Typing a space in a pane or a
  dialog field never opens the microphone.
- A hold shorter than **300 ms** is treated as a stray tap and discarded silently,
  so a bounced key costs nothing.
- A finished hold whose audio holds less than **250 ms** of voiced sound is
  discarded with the bundled "I didn't catch that. Hold Space and try again."
  clip. Nothing is uploaded.
- The two seconds of microphone history before the key went down are prepended to
  the recording, so a word started slightly before the press survives.
- **Space during a spoken reply interrupts it** and starts recording (barge-in).
  Space while the app is transcribing or waiting for the assistant is refused with
  `{ ok: false, status: 'busy' }`; the indicator shows why.
- Releasing is not the only way a turn ends: the 60 s maximum recording length
  closes and uploads a turn that is still being held.
- Window blur or the window becoming hidden while holding ends the turn the same
  way a release would (send if held past 300 ms, otherwise discard).
- **Questions from agents use the same gesture.** After a question is read out the
  app waits in `awaiting-answer`; hold Space to answer. Answers are matched by
  `voiceAnswers.cjs` exactly as before, and a question left unanswered for 15 s
  still gets the missed-speech alert.
- The microphone stays open the whole time voice is enabled. Mute (the small mic
  button) or turning Orchestrator off releases the device completely.
- The indicator's large mic button is the mouse equivalent: press and hold,
  release to send; leaving the button while held releases it. While the app is
  transcribing or thinking the same button stops the request instead.

## Wiring

- `configure({ pushToTalk: 'start' | 'stop' | 'cancel' })` on the existing
  `voice:configure` IPC channel is the whole API. `start` requires `listening`.
- `frontend/VoicePushToTalk.tsx` is mounted once next to `<VoiceIndicator/>` in
  `App.tsx`; it owns the window key listeners and holds no React state.
  `frontend/voice/pushToTalk.ts` holds the 300 ms tap rule shared with the
  indicator's mic button.
- `backend/voiceController.cjs` keeps a two-second `recentAudio` ring whenever the
  microphone is open and nothing is recording, and starts the recording from it.
- `backend/voiceAudio.cjs` `createRecording({ endpointing: false })` disables the
  silence detector: only the maximum-length cap can end a held turn.

## Historical cleanup before hands-free voice

The following describes the earlier removal of the original wake implementation.
The current optional implementation has its own models and helper lifecycle.

- `backend/voiceWake.cjs`, `backend/voiceWakeHost.cjs`, `backend/voiceWakeProcess.cjs`.
- The `sherpa-onnx-node` dependency, its `sherpa-onnx-win-x64` binaries, and the
  two `asarUnpack` entries that shipped them.
- The keyword model in `vendor/voice` (encoder/decoder/joiner `.onnx`, `bpe.model`,
  `tokens.txt`, `hey-vibe.txt`, `manifest.json`, model LICENSE/NOTICE/README).
  `vendor/voice/alerts` — the bundled offline alert clips — stays and still ships.
- `scripts/dev/prepare-voice-model.cjs` (so `npm run prepare:voice` is now only
  `verify-error-audio`), `scripts/backend/voice-packaged-smoke.cjs`, the packaged
  native/model assertions in `scripts/qa/verify-release-artifacts.cjs`, and the
  `voice-wake-native` / `voice-wake-process` tests.
- The `wakeReady`, `wakeError`, `wakeErrorDetail` state fields, the `starting` and
  `wake-error` phases, and the `manual-only` degraded activation result. Voice now
  either listens or reports why it cannot.
- The transcription prefix strip that removed a leading "hey vibe" from every
  transcript.

`enabledOnLaunch` is unchanged and still means "open the microphone at launch".

## Verification

- `npm run test:orchestrator` — 300 tests. Push-to-talk cases live in
  `scripts/backend/voice-pipeline.test.cjs` (ring + hold upload, silent hold
  discarded with no upload, cancel uploads nothing and says nothing, barge-in over
  a reply, busy refusal, maximum-length cap, an answer given by holding) and
  `scripts/backend/voice-recording-preroll.test.cjs` (pre-roll accounting and the
  un-endpointed hold).
- `npm run smoke:electron:voice-experience` drives real Chromium key events over
  CDP against a real microphone stream: Windows SAPI synthesizes a WAV that is fed
  in with `--use-file-for-fake-audio-capture`. The checkpoints
  `space-inside-a-terminal-pane-never-records` and
  `space-hold-records-live-microphone-and-uploads-it` assert the guard, the
  `listening → recording → transcribing` transition, and that the stubbed
  transcription endpoint received a WAV carrying that audio (peak 31957 of 32767,
  56000 samples for a 1.5 s hold plus its ring).
- `npm run smoke:frontend:voice-experience` covers the indicator copy.
- `node scripts/qa/release-checks.cjs` runs all of the above as part of the gate.

## Limits

- No physical microphone, no audible playback, and no live OpenRouter request were
  part of this pass; the fake device and the stubbed provider stand in for both.
- The Electron smoke's terminal-pane guard uses an injected `[data-pane-id]` host
  with a textarea rather than a live PTY pane, so it exercises the guard's real
  selector but not a real xterm instance.
- Space is a global gesture with no rebinding, and there is no visible hint of the
  key beyond the indicator's label.
