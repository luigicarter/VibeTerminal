# Orchestrator voice deep dive (September 5, 2026)

Troubleshooting pass over the Hey Vibe voice feature after two repair releases (0.1.87 "repair voice lifecycle", 0.1.88 "repair spoken replies and missed-speech feedback") still left two complaints: turns kept failing, and "the voice is very robotic". This document records how the pipeline actually behaves on a real machine, which root causes were found with evidence, what was ruled out, what changed, and what remains unverified. `docs/orchestrator-voice-fixes.md` and `docs/orchestrator-context-and-audio.md` describe the feature as designed; this file describes what was measured.

## Method

Three tracks, all against the installed 0.1.89 layout and the repo at the same version:

- Baseline: `npm run test:orchestrator` (289 tests at the time) and `npm run smoke:electron:voice-experience` both passed before any change. The smoke injects a synthetic recording through `voice.sendAudio()`; it never drives the wake word or the endpointer with audio, which is the gap that let the main defect ship.
- Live reproduction: Windows SAPI synthesized "Hey Vibe" plus a command into 16 kHz WAVs, fed to the real app through Chromium's fake microphone (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`), with the smoke's provider stub, an isolated userData directory, and every `voice:state` transition, wake-helper event, provider request, and hidden-window Web Audio call logged with timestamps. The same WAVs were also run offline through `createWakeDetector` and `createRecording`.
- Static defect hunt: every voice file read end to end, each suspect settled with a small repro script or a quoted code path, plus the public OpenRouter catalog for the configured models.

No physical microphone, no audible playback, and no authenticated OpenRouter call were part of this pass. Those limits are listed at the end.

## What the pipeline actually does

Measured in the live run (fake mic, stubbed provider):

| Stage | Result | Measurement |
| --- | --- | --- |
| Enable to listening | works | 1.27 s; wake helper ready in 0.98 s; first mic frame 150 ms after enable |
| Wake helper throughput | works | 1.0 to 1.9 ms inference per 100 ms frame, max 8.7 ms; the 4-frame IPC queue cap is never approached |
| Wake detection, offline | works | 9 of 9 clips (3 SAPI voices at 0, -12, -24 dB); 0 false positives over 84 s of non-wake speech |
| Wake detection, live | mostly works | one of two identical utterances missed (see "ruled out" for why) |
| Recording and endpointing | failed | capture closed 400 ms after the wake word, before the command |
| Transcription request | works | valid 16 kHz mono 16-bit WAV, JSON body with `input_audio` |
| Relay and speech request | works | Kokoro `hexgrad/kokoro-82m`, voice `af_heart`, `response_format: pcm` |
| Chunking and playback | works | 1 s chunks at 24000 Hz mono; hidden window ACKs 133 ms after the audio ends, well inside the 5 s watchdog slack |

## Root causes

### 1. The recording closed before the user started speaking

`createRecording` in `backend/voiceAudio.cjs` ran its voice/silence accounting over the pre-roll (the two seconds of mic history handed over when the wake word fires). The pre-roll always holds the wake word (about 600 ms voiced, which already satisfies the 250 ms minimum) followed by the silence between detection and the user's next word. That silence was charged against the 900 ms end-of-speech budget, so the user had whatever remained, typically 300 to 400 ms, to begin talking. Captured in the run:

```
pre-roll frame RMS: [0,0,0,0,0,0,0,0, 0.00002, 0.0267,0.15116,0.07191,0.13712,0.07074,0.01346,0.00126,0.00003, 0,0,0]
live push 1..3: rms=0 result=recording   live push 4 (400 ms): result=complete
```

The uploaded audio contained only "Hey Vibe". `sendAudio` strips that prefix, the remainder has no letters, and the app plays the "I didn't catch that" clip. Replayed against the captured mic stream, the old code ended the recording at 13.5 s while the command started at 14.3 s; the fixed code captures the whole command (ends at 16.3 s).

### 2. The robotic voice is the fallback clip set, not Kokoro

The 14 clips in `vendor/voice/alerts/` are rendered by Windows SAPI "Microsoft Zira Desktop" (`manifest.json`, `generator` and `voice` fields), 4.4 to 7.1 s each. Kokoro is heard only when the whole chain succeeds; every failure speaks Zira, and voice-origin failures skip the 60 s repeat cooldown by design. With root cause 1 firing on most turns, the user heard Zira far more often than Kokoro.

### 3. The configured Brain model cannot answer inside the old budget

The saved settings use `z-ai/glm-5.3-flash`. The public catalog lists it with `reasoning.mandatory: true` and `default_effort: "max"`, while the relay sent `max_tokens: 1200` (monitor: 350). Reasoning tokens count as output, so the model can spend the entire budget thinking and return `finish_reason: "length"` with no content, which the relay turned into an error and the voice path into the "orchestration" Zira clip. This is the best single explanation for turns that never produced a reply. It is proven at the metadata level only; one authenticated request confirms it.

### 4. A malformed `preferences` value can blank the app

The user's `orchestrator-settings.json` stored `preferences` as `{}` instead of an array. The loader kept it verbatim, `OrchestratorSettings.tsx` calls `.map` on it during render, and `frontend/` has no error boundary, so opening Settings unmounts the React root. Remember/forget preference and the policy check threw as well. The repo never writes that shape; it came from outside, but the loader has to normalize it regardless.

### 5. Wake failure switched off the whole Orchestrator

`voiceController` deliberately returns `status: 'manual-only'` when the wake helper cannot start, but `installOrchestrator` treated anything without `wakeReady` as failure and disabled the relay, the mic, and Talk now together. A 15 s cold start of `onnxruntime.dll` plus the int8 model therefore took the text assistant down with it.

### 6. A stuck audio window was never replaced

`ensureReady` timed out after 15 s but kept the hidden renderer, so the advertised "turn Hey Vibe off and on" retry waited another 15 s on the same dead window.

### 7. The wake helper's stderr was discarded

The helper was forked with stderr ignored, so a native loader failure surfaced only as "Hey Vibe is unavailable" with nothing to diagnose.

### 8. Speech decoding failed closed on benign content types

`decodeSpeechAudio` rejected any `audio/pcm` response with an extra parameter or a missing rate or channel count, and routed `application/octet-stream` raw PCM to the WAV parser. Each of those became a "speech failed" Zira clip. OpenRouter documents `audio/pcm;rate=24000;channels=1`, but Kokoro is served by two providers with no provider pin, so header shape is not guaranteed.

## Ruled out

- Wrong sample rate or pitch: the decoder never guessed a rate, it failed instead, so slowed or deepened Kokoro was impossible.
- Hidden-window throttling: `backgroundThrottling: false` and `autoplayPolicy: 'no-user-gesture-required'` are set; measured `setTimeout(100)` delays were 100 to 112 ms; the AudioContext stayed `running`; playback ACK arrived 133 ms after the audio ended.
- PCM chunk boundaries: always frame-aligned; odd byte counts are rejected before chunking.
- Playback watchdog: about 4.9 s of slack at every reply length; IPC marshalling tops out near 277 ms for a 3 minute reply.
- Packaging: the installed 0.1.89 contains `sherpa-onnx-win-x64` binaries, the model files, and all 14 alert clips; the native addon loads under plain Node.
- Legacy `openai/gpt-4o-mini-tts` settings: migrated to Kokoro in memory on load and re-persisted on the next save.
- Wake thresholds: a 12-point sweep (threshold 0.25 to 0.10, score 1.5 to 2.5) over 144 wake trials and 96 non-wake trials found zero false positives everywhere and no setting that removes the live miss. The miss depends on how much audio the streaming decoder consumed before the word, not on the threshold; lowering it only reshuffles which contexts fail. The constants were left unchanged.

## Changes landed

All uncommitted, for review. Tests: 301 pass, smoke 12 checks pass, `npm run typecheck` clean.

- `backend/voiceAudio.cjs`: pre-roll audio is kept for transcription but no longer feeds the endpointer; its voiced duration is exposed as `preRollVoicedMs`. `decodeSpeechAudio` ignores unknown content-type parameters, defaults a missing rate or channel count to Kokoro's native 24000 Hz mono (`TTS_NATIVE_RATE`, `TTS_NATIVE_CHANNELS` in `shared/voiceConfig.cjs`), and sniffs unlabeled bodies for a RIFF header before treating them as raw PCM. Parameters that contradict 16-bit signed PCM still fail.
- `backend/voiceController.cjs`: when live audio stays silent but the pre-roll holds more voiced audio than a wake phrase (`PRE_ROLL_COMMAND_MS`, 800 ms), the audio is uploaded so transcription decides, instead of being discarded. `audio/vnd.wave` is now admitted by the content-type gate. `wakeErrorDetail` carries the helper's stderr tail in `voice:state`.
- `backend/orchestrator.cjs`: output budget scales with context (minimum 1200, up to 4000 for the Brain, 1200 for the monitor); `reasoning: { effort: 'low' }` is sent only to models whose catalog entry advertises `reasoning`; `finish_reason: length` and an empty reply each produce a specific message.
- `backend/orchestratorSettings.cjs` and `frontend/components/OrchestratorSettings.tsx`: preferences are normalized to well-formed entries on load and on persist; the panel renders defensively.
- `backend/orchestratorIntegration.cjs`: a wake startup failure with healthy capture is a degraded success (`status: 'manual-only'`) on both the enable path and the settings-change restart path: relay enabled, mic on, Talk now available, wake-error text visible. `audio/L16` stays refused because RFC 2586 defines it as big-endian.
- `backend/voiceOverlayWindow.cjs`: the ready timeout destroys the stuck renderer so the retry builds a fresh one; the timeout is injectable for tests.
- `backend/voiceWakeProcess.cjs`: stderr is piped into a bounded 2 KB tail attached to the failure.
- Tests: `scripts/backend/voice-wake-preroll-endpoint.test.cjs` (new, encodes the captured run), plus updates in `voice-pcm-format`, `voice-pipeline`, `voice-lifecycle`, `voice-wake-process`, `orchestrator-relay`, and `orchestrator-settings` tests.

## Still unverified

- The real provider: the content type Kokoro's providers send for `pcm`, and whether the new budget and `reasoning.effort` let `z-ai/glm-5.3-flash` answer. Both need one authenticated request. If a turn still fails, the reply text now names the budget rather than a generic upstream failure.
- Audible quality: nothing in this pass listened to the output. The "robotic" attribution rests on provenance and trigger paths.
- Physical microphone behavior: AGC, noise suppression, and echo cancellation on a real device were not exercised; the fake device produced a suspiciously quiet second pass that may be a capture artifact.

## Recommended follow-ups

- Regenerate the alert clips with Kokoro at build time, or shorten them; failure speech should match success speech.
- Endpointer tuning with data: a 900 ms pause truncates a sentence, answers under 250 ms ("yes", "stop") can never complete, speech below 0.012 RMS is treated as silence, and there is no start-of-recording cue before the 6 s grace expires.
- Trim trailing silence before uploading a banked pre-roll (it can carry up to 6 s of quiet).
- Give the answer path the same pre-roll the wake path has, so a reply spoken over the tail of the question keeps its first word.
- Restart the wake helper after a mid-session crash and stop streaming mic frames while it is down.
- Retry `getUserMedia` without the saved `deviceId` when it no longer exists; watch for a mic that stops producing frames.
- A `voice:diagnostics` ring plus "Copy diagnostics" in the indicator menu; `wakeErrorDetail` is the first field of that surface.
- An error boundary around the Settings dialog.

## Reproducing the live harness

Synthesize speech with `System.Speech` in PowerShell (`SetOutputToWaveFile` with a 16 kHz, 16-bit, mono `SpeechAudioFormatInfo`), leave 10 to 12 s of leading silence and a long tail because Chromium loops the capture file, then launch Electron with the fake-media switches above, `ELECTRON_RUN_AS_NODE` removed from the environment, an isolated userData directory, and a wrapper `main.cjs` modeled on `scripts/qa/voice-experience-smoke.cjs` that stubs `fetch` and records `voice:state` broadcasts. Offline, `createWakeDetector` and `createRecording` accept the same 1600-sample frames directly.
