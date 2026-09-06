# Optional hands-free voice

Enable **Hands-free voice** in Orchestrator settings and choose **Save changes**.
It defaults off. Space push-to-talk remains available with its existing terminal
and text-field guards. There is no enrollment, training, or additional account.
Transcription and spoken replies still use the existing OpenRouter configuration.

Wake detection runs while idle, including when the workspace is in the background.
It pauses during recording, transcription, assistant work, and playback. Space can
interrupt playback. When a spoken question finishes, hands-free mode listens for
the answer automatically and retains the question's pane/generation/revision identity.

## Models and processes

- `sherpa-onnx-node` and its Windows native package are pinned to 1.13.7. The English
  GigaSpeech 3.3M 2024-01-01 int8 model recognizes the build-time BPE keyword
  configuration `HEY VIBE`. The label is `HEY_VIBE`; labels cannot contain spaces.
- Silero identifies speech, including short answers. Smart Turn v3.2 CPU int8
  classifies completion after 200 ms of quiet. Its latest-eight-second input is
  left-padded and normalized using a JavaScript implementation checked against
  the upstream Whisper feature extractor. The complete command remains buffered.
- One app-wide service owns two hidden helpers: keyword/VAD and semantic completion.
  Each uses one CPU thread. Separate processes avoid incompatible ONNX Runtime
  DLLs being loaded into the same Windows process. No Python installation or GPU is required.
- Keyword detection uses a continuous stream plus a companion sharing the same
  model. The companion is refreshed on a speech onset after 200 ms quiet, with
  a two-second cooldown and 300 ms replay. This addresses context and framing
  misses without resetting the primary stream mid-speech. Detections are deduplicated.
- Native token timestamps lose their absolute origin after upstream resets. Reported
  positions are conservative approximations and are never used to trim recordings.

`vendor/voice/models/manifest.json` pins model and notice bytes, hashes, and sources.
`npm run prepare:voice` verifies them offline when present and restores missing
pinned assets. Corrupt files fail verification. Existing `.gitattributes` rules
preserve vendored voice bytes across Windows checkouts. The installer places these
assets under `resources/voice/models` and unpacks the native runtimes and helpers.

## Recording and failure behavior

The single audio renderer sends 16 kHz mono PCM in 20 ms packets carrying a capture
token and sample position. A worklet flush/acknowledgment includes the final partial
packet before a manual release can submit. Old capture frames, duplicate packets,
and obsolete flush acknowledgments are rejected.

The controller owns recording and dispatch. Wake, answer, and manual recordings have
separate ownership. A hold adopts an automatic recording; a short tap restores it,
and a later hold cannot be committed by an older release. Completion results carry
turn and speech revisions and wait for queued VAD classifications before commitment.
Only one completion check runs per unchanged speech revision/pause.

Wake activation gives six seconds for command speech. A leading wake phrase is
removed only from a wake-origin transcript; a wake-only result never reaches the
assistant. A very short command already entirely buffered before wake detection
can also wait through that six-second grace. Its audio is retained; this is a known
latency limit of the conservative boundary handling.

An uncertain completion keeps listening, with a Space hint after three seconds of
quiet. Automatic capture cancels at 60 seconds rather than dispatching an unfinished
command. Questions expire after 15 seconds without an answer; speech classification
stops that timer. Manual recording retains its existing length cap.

Startup has a 15-second deadline, completion a one-second deadline, each streaming
response a two-second deadline, and streaming backlog is limited to 500 ms. The streaming
deadline also catches a stalled helper after microphone delivery pauses.
Failure disables hands-free for that activation and
cancels affected automatic recording with feedback. Text and Space remain usable.
Toggle hands-free off/on to retry. Mute, disable, and shutdown release the helpers.
Diagnostics contain timing and bounded errors, not microphone content or keys.

## Verification

- `npm run test:orchestrator`: controller ownership, stale results, answer routing,
  capture/flush boundaries, helper failures, model checksums, and feature parity.
- `npm run test:voice:capture` and `npm run smoke:frontend:voice-experience`:
  worklet resampling/flush, gestures, settings, and indicator behavior.
- `npm run smoke:voice:native`: actual keyword/VAD/completion models using Windows
  System.Speech fixtures, including negative audio and long commands.
- `node scripts/qa/voice-keyword-matrix.cjs`: additional preceding speech, volume,
  packet-boundary, and spaced-phrase regressions after native fixtures are generated.
- `npm run smoke:electron:voice-experience`: Chromium fake microphone through real
  capture, native helpers, automatic completion, and scripted provider responses.

Synthetic fixtures do not establish physical-microphone accuracy or minimum CPU
requirements. Model files are much smaller than the helpers' total runtime memory.
Native reports under `output/voice-handsfree` identify the measured CPU and limits.
