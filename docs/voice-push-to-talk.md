# Voice push-to-talk

Hold **Space** to record and release to send while no terminal or text field is
focused. Optional [hands-free voice](voice-handsfree.md) adds “Hey Lina” and
automatic completion. See the [voice deep dive](orchestrator-voice-deep-dive.md)
for architecture, version boundaries, and remaining reliability findings.

A short, rising two-note cue plays when a Space or mouse hold starts recording,
when “Hey Lina” activates capture, or when an automatic answer window is ready.
Switching between automatic capture and a hold does not repeat the cue.
The existing soft bell followed by “done” marks completion of an Orchestrator
instruction. Standby has no listening cue; mute, cancellation and microphone
recovery stop any pending listening sound.

The microphone shows status through its color: teal for standby, blue for
recording or awaiting an answer, purple for transcription or assistant work,
green for playback, gray for muted, and amber for errors or microphone/hands-free
startup, recovery, or unavailability. Status text remains available to screen
readers, with no floating status bubble or microphone tooltip. Hovering still
reveals the mute and dismiss controls; right-click opens voice options.

## Gestures

- Space is ignored inside a terminal pane (`[data-pane-id]`), input, textarea,
  select, textbox, or contenteditable element, and with Ctrl, Alt, or Meta.
- A hold shorter than **300 ms** is a stray tap and is discarded. If it adopted
  an automatic recording, control returns to that recording with a fresh silence
  interval; pre-hold quiet cannot trigger an immediate automatic send.
- A manual recording with less than **250 ms** of RMS-voiced audio, including
  pre-roll, gets the bundled missed-speech prompt instead of an upload.
- Two seconds of microphone history are prepended so early syllables survive.
- Space during playback interrupts the reply and starts a manual recording.
- Space is ignored during transcription and assistant work. The microphone's
  mouse action can stop that request.
- Releasing Space, losing window focus, or hiding the window ends a held turn.
  A sufficiently long hold sends; a short tap cancels. A held recording also sends
  at its maximum audio length.
- Manual mouse recording uses the same hold duration rule; release or leaving
  the button ends the hold. During automatic recording, the interface instead
  offers click-to-send, with the original recording and pointer identities.
  An obsolete pointer completion cannot release or send a newer gesture.
- Agent questions preserve session/generation/request/revision identity.
  Hands-free answers start automatically after question playback; Space can
  answer manually. The unanswered window expires after 15 seconds of classified
  silence. See the hands-free guide for its capture rules.

## Ownership and IPC

`VoicePushToTalk.tsx` owns window keyboard listeners and `VoiceIndicator.tsx`
owns mouse controls. Each uses its own instance of `pressToTalk` from
`frontend/voice/pushToTalk.ts`; unique hold IDs fence overlapping gestures.
The hidden `VoiceOverlay` owns the microphone and playback, independently of
whether the indicator is visible.
`frontend/voice/listeningCue.ts` observes live state transitions in that single
audio renderer. Its local PCM cue has a separate player so it cannot acknowledge
spoken replies or change answer routing. No speech service request is needed
for the listening sound.

`configure({ pushToTalk: 'start' | 'stop' | 'cancel', holdId })` carries manual
input. `configure({ finishRecording: recordingId })` finishes the identified
current automatic recording. The main process flushes final worklet samples
before a manual release or automatic Send can submit. Obsolete capture tokens,
hold IDs, recording IDs, and flush acknowledgments cannot submit a later turn.
Initial state loading cannot overwrite a newer live voice-state event. Manual
start and flush failures update the authoritative backend voice state for the
matching hold; a stale failure cannot cancel or report an error on a later hold.

`backend/voiceController.cjs` owns the recent-audio ring and turn state.
`backend/voiceAudio.cjs` records held turns with silence endpointing disabled;
manual release or the maximum length ends them. Optional hands-free inference
uses the current bundled models and separate helpers described in its guide.

## Verification and limitations

- `npm run test:orchestrator` covers recording ownership, cancellation, speech
  routing, quiet holds, playback interruption, and capture/flush boundaries.
- `npm run test:voice:capture` covers resampling, worklet flushing, and gestures.
- `npm run smoke:frontend:voice-experience` covers settings and visible controls.
- `npm run smoke:electron:voice-experience` drives Chromium key/pointer events,
  fake microphone audio, real native helpers, and scripted provider replies.

Space is a window-level gesture without rebinding, not a system-wide hotkey.
Synthetic audio and playback acknowledgments do not verify a physical microphone
or audible speakers. Voice remains turn-based: wake detection pauses during
playback, and muting disables voice rather than only silencing output. See the
deep dive for remaining wake-tail and microphone-delivery limits; passing smoke
tests are not complete physical-audio UX coverage.
