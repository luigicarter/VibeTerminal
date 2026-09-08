# Optional hands-free voice

Enable **Hands-free voice** in Orchestrator settings and choose **Save changes**.
It defaults off. Space push-to-talk remains available with its existing terminal
and text-field guards. There is no enrollment, training, or additional account.
Transcription and spoken replies still use the existing OpenRouter configuration.

Wake detection runs while idle and while preparing or playing a spoken reply,
including when the workspace is in the background. Say **Hey Vibe** to stop the
reply and give your next command. This also discards queued speech from before
the interruption, without cancelling terminal work. Detection pauses during
recording, transcription, and assistant work. Space also interrupts playback.
When a spoken question finishes, voice listens for the answer
automatically and retains the question's request or pane/generation/revision identity.
Saying Hey Vibe or holding Space while a question is being generated or spoken retains
that answer route, including earlier answers on a multi-question form. A short
tap returns to its answer window; replaced questions cannot receive stale answers.
The model explicitly marks whether its response needs a reply; punctuation does not
decide microphone behavior. Questions and decisions open a fifteen-second answer
window. Completed replies return to standby. Followup detection also runs temporarily
when **Hands-free voice** is off, without enabling wake detection or changing the
saved preference. If the detector cannot start, the indicator offers Space to answer.
Conversational follow-ups carry their original request identity and bounded
exchange context through both model stages, even after other requests fill recent
history. Explicit choices such as “the second one” work without an extra model
turn; qualified answers still go through the Orchestrator.

Say **never mind**, **that's all**, **stop listening**, **dismiss**, or **go back to
sleep** to dismiss the voice exchange, or click the indicator's **X**. These phrases
must be the whole utterance (an optional Vibe/Hey Vibe and “please” are accepted).
They stop capture/playback and return to standby without submitting an answer,
granting permission, cancelling terminal work, or changing the microphone preference.
Pending questions remain in the conversation. Commands such as “dismiss the dialog”
still go to the Orchestrator. The indicator stays visible; its menu separately offers
**Hide microphone · keep listening**. Mute turns off the microphone.

## Models and processes

- `sherpa-onnx-node` and its Windows native package are pinned to 1.13.7. The English
  GigaSpeech 3.3M 2024-01-01 int8 model recognizes the build-time BPE keyword
  configuration `HEY VIBE`. The label is `HEY_VIBE`; labels cannot contain spaces.
- Silero identifies speech, including short answers. Smart Turn v3.2 CPU int8
  classifies completion after 200 ms of quiet, but sending waits for at least
  1.2 seconds of uninterrupted quiet. Its latest-eight-second input is
  left-padded and normalized using a JavaScript implementation checked against
  the upstream Whisper feature extractor. The complete command remains buffered.
- One app-wide service owns two hidden helpers: keyword/VAD and semantic completion.
  Each uses one CPU thread. Separate processes avoid incompatible ONNX Runtime
  DLLs being loaded into the same Windows process. No Python installation or GPU is required.
- Keyword detection uses a continuous stream plus a companion sharing the same
  model. The companion is refreshed on a speech onset after 200 ms quiet, with
  a two-second cooldown and 300 ms replay. This addresses context and framing
  misses without resetting the primary stream mid-speech. Detections are deduplicated.
  The companion applies a fixed gain chosen from that onset (target peak 0.15,
  maximum 8×) to help quiet speech; later samples are clipped to the PCM range.
  Gain stays fixed until its next onset/reset. The primary stream, VAD input and
  keyword confidence threshold remain unchanged.
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

During playback, the microphone keeps its existing echo cancellation, noise
suppression, and automatic gain control. A current keyword detection interrupts
speech; ordinary speech activity alone does not. The two-second capture buffer
preserves the wake phrase and command onset across cancellation. Stale detector,
speech-provider, and playback callbacks cannot replace the new recording.
Speaker echo and real-room recognition still require physical microphone checks.

The controller owns recording and dispatch. Wake, answer, and manual recordings have
separate ownership. A hold adopts an automatic recording; a short tap restores it
with a fresh silence interval, so quiet accumulated before the hold cannot end
the returned recording prematurely. A later hold cannot be committed by an older release. Completion results carry
turn and speech revisions and wait for queued VAD classifications before commitment.
Only one completion check runs per unchanged speech revision/pause. Speech
resuming before commitment invalidates the completion result.

The microphone now shows its status as visible text. During an automatic
recording it becomes a **Send** button: click to send immediately, or keep
speaking and let the pause end the recording. Leaving/cancelling a click does
not send. The button flushes the worklet and carries the recording identity;
an old click cannot send a later recording. Space remains hold-to-talk.

Wake activation gives six seconds for command speech. A leading wake phrase is
removed only from a wake-origin transcript; a wake-only result never reaches the
assistant. A very short command already entirely buffered before wake detection
can also wait through that six-second grace. Its audio is retained; this is a known
latency limit of the conservative boundary handling.

An uncertain completion sends after three seconds of uninterrupted quiet once
at least 250 ms of command speech has been detected. Shorter uncertain speech
ends after that pause without transcription or an assistant request. Wake-origin
turns use a local missed-speech clip; a current pending question is repeated
through TTS and preserved for another answer attempt.
Automatic capture cancels at 60 seconds
if speech keeps it open. Questions expire after 15 seconds without an answer; speech classification
stops that timer. Manual recording retains its existing length cap.

Keyword startup has a 15-second deadline and each dispatched streaming response
has a two-second deadline. Only one frame is in flight; up to two seconds of audio
can wait in the parent queue. Short delivery bursts retain every classification.
Sustained idle wake backlog discards stale queued audio and resets the stream at
the gap; recording/VAD backlog instead cancels the incomplete automatic turn.
Keyword faults retry after 0.5, 1.5 and 4 seconds, at most three times in a rolling
minute. Space remains available during recovery. Persistent failures show an
explicit unavailable state; toggling hands-free retries with a fresh budget.

Semantic completion loads and retries independently (1, 2 and 4 seconds). Its
one-second inference deadline never disables a healthy wake/VAD helper. While
completion is unavailable, the existing three-second classified-silence fallback
finishes commands. Each helper verifies only its own required model assets;
offline preparation still verifies the entire pinned manifest.

Capture also has a PCM heartbeat: 3.5 seconds without packets attempts to resume a
suspended audio context, with one second of grace. Main independently detects six
seconds without incoming PCM. A stall rotates the capture token and recreates the
graph, showing “Reconnecting microphone”; interrupted recordings/flushes are
cancelled, never uploaded. Recovery permits three restarts per rolling minute
and requires a readiness acknowledgment within 15 seconds. Zero-valued audio is
healthy; stale packets, acknowledgments and retries cannot cross a token change.
Mute, settings changes, and shutdown cancel pending recovery.
Diagnostics contain recording start/finish/cancel reasons, pause duration,
completion confidence, processing timing and bounded errors, not microphone
content, transcripts or keys. This distinguishes a missed wake from a recording
that started, or a provider/interpretation failure after capture.

## Verification

- `npm run test:orchestrator`: controller ownership, stale results, answer routing,
  capture/flush boundaries, helper failures, model checksums, and feature parity.
- `npm run test:voice:capture` and `npm run smoke:frontend:voice-experience`:
  worklet resampling/flush, gestures, settings, and indicator behavior.
- `npm run smoke:voice:native`: actual keyword/VAD/completion models using Windows
  System.Speech fixtures, including negative audio and long commands.
- `node scripts/qa/voice-recovery-smoke.cjs`: after generating the native fixtures,
  verifies burst handling, completion-helper isolation, and another native wake
  after a forced keyword-helper crash without toggling voice or submitting audio.
- `node scripts/qa/voice-keyword-matrix.cjs`: additional preceding speech, volume,
  packet-boundary, and spaced-phrase regressions after native fixtures are generated.
  It includes David/Zira synthetic voices at three speaking rates, low-amplitude
  speech, deterministic background noise, near-phrase negatives and noise alone.
- `npm run smoke:electron:voice-experience`: Chromium fake microphone through real
  capture, native helpers, automatic completion, and scripted provider responses.
- `npm run smoke:voice:workflow` (after `npm run smoke:voice:native` creates
  fixtures): real helpers plus controller with a two-second wake-to-command gap,
  a mid-command pause, and a wake-only attempt.
- `node scripts/qa/voice-wake-interruption-smoke.cjs`: real local models recognize
  a synthetic wake during speech preparation and streaming, cancel old speech,
  and capture/dispatch the subsequent command through mocked cloud endpoints.

Synthetic fixtures do not establish physical-microphone accuracy or minimum CPU
requirements. Model files are much smaller than the helpers' total runtime memory.
Native reports under `output/voice-handsfree` identify the measured CPU and limits.

The [voice deep dive](orchestrator-voice-deep-dive.md) records local validation,
installed/source version boundaries, repaired handover/short-speech behavior and
remaining limits such as delayed wake-tail handling and missing detection of a
microphone that silently stops delivering frames. Its live-provider evidence covers a synthetic spoken
greeting; physical microphone recognition and audible speaker playback remain
separate user checks.
