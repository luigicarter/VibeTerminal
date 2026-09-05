# Orchestrator voice fixes

Local build: **0.1.86**. The Windows installer is prepared locally; this change
does not publish a GitHub release or replace a running installed application.

The correction replaces the required floating panel and bottom dock with a
58px glowing mic in a 112px control area inside the main vibeTerminal window.
It cannot overlay another application. The session list is removed; a gear and
Settings label sit at the bottom of the sidebar. History and other workspace
tools remain available on demand.

Normal setup is an API key, model name, and the Orchestrator toggle. Enabling
saves those entries, validates the account and supported models, initializes
the audio renderer, and waits for both microphone capture and local wake
detection. A saved key is disabled/grey with an explicit Change button. Optional
voice, device, preview, startup, budget and reporting controls are in Advanced.

The first microphone request now shows an app-owned native consent dialog with
**Allow microphone** and **Not now** before capture or wake-helper startup. Allow
is remembered in `microphone-consent.json`; denial and cancellation cannot activate
capture. The same gate protects microphone device refresh. Automatic/background
startup never opens this popup over another application. A Windows-denied state
offers an explicit link to the Windows microphone privacy page; it does not
change OS permissions. This is a vibeTerminal dialog, not the Microsoft Store
permission prompt that ordinary Windows desktop apps cannot request.

Hide/X dismiss the in-app indicator while a permanently hidden, non-focusable
audio renderer remains alive. The toolbar restores the indicator inside the app.
The audio renderer is never shown or always-on-top. Turning Orchestrator off stops capture
and the native helper. Closing the application stops both. Startup listening is
an explicit saved preference. Settings changes restart only affected audio or
connection work; changing a spending limit does not cancel a command.

The unavailable legacy speech selection is migrated to `hexgrad/kokoro-82m`,
Heart (`af_heart`). Supported presets are explicit. Speech comes from OpenRouter;
there is no local speech-generation model to install. Speech requests use PCM;
response metadata determines the sample rate/channels, with bounded size/duration
and acknowledged playback. WAV responses remain supported when correctly framed.
Missed speech and failures use bundled spoken explanations and stage-specific
text. Text/action success and speech failure remain separate results.

Automatic activity reports are off by default. Explicitly enabled reporting
ignores paused/unavailable output, excludes reports from conversational context,
and does not publish token-truncated responses. Natural command forms accept
optional punctuation and common request prefixes while preserving exact payloads,
targets, and launch generations. Rejected actions create receipts.

Relay controls use internal renderer/PTY/agent IPC, with no global keyboard or
clipboard input. Model tools cannot open external files/folders; those explicit
mouse actions remain in Workspace tools. Internal pane selection does not bring
the app to the foreground. This confines the relay, not the programs an explicitly
instructed terminal or agent can execute.

## CPU and memory

Wake detection remains the bundled sherpa-onnx int8 keyword model, approximately
5 MiB of model files, using `provider: cpu` and one inference thread. Capture sends
one 100ms frame at a time (10 per second), with one inference frame in flight and
at most four queued. No GPU, local transcription model, or new heavyweight
dependency is introduced. Disabled Orchestrator no longer polls UI inventory.
The mic's idle glow is static; active animations pause while hidden.

A task-owned helper on this development machine processed ten seconds of paced
digital silence in 10.921 seconds using 125ms CPU time: approximately 1.14% of
one core. It used 92.7 MiB working set and had no pending backlog at completion.
The helper was disposed after measurement. This measures the helper, not the
whole Electron application, and does not predict performance on every CPU or
microphone/noise environment. A silence gate was deliberately avoided because
its threshold could reduce quiet wake-phrase sensitivity.

## Verification

The 0.1.85 combined backend run passed 243 tests, including 12 integration
lifecycle regressions covering native hide, failed-window recovery, renderer/capture
acknowledgments, late microphone tokens, wake failure ordering, cancellation,
invalid audio settings, and hidden preview startup. Native tests detect synthetic
"Hey Vibe" and reject unrelated speech using the actual bundled CPU detector.
Frontend checks cover the simple settings flow, saved-key lock, stale snapshot
protection, capture acknowledgment, hidden animations, and playback while muted.
The production build and existing App runtime/workspace/split checks pass.

Final isolated Electron QA passed at
`.tmp/voice-experience-smoke/1788645775282-46716/`. Parent inspected results and
screenshots: simple settings, grey saved key, no primary session list/dock, Settings
footer, main-window mic bounds, permanently hidden/non-focusable audio renderer,
zero native show events, microphone readiness, hide/show preserving listening,
tracks ending on Off, native helper shutdown, and silent WebAudio playback ACK.
Provider replies and microphone input were fixtures.

The scripted command test passed at
`.tmp/orchestrator-command-smoke/1788645778804-51860/`: real evaluated PTY output,
wrong-payload/stale-target refusal, cancellation, native history/resume and follow-up
identity. Another application's foreground PID and clipboard sequence stayed
unchanged across 17 samples, with zero observed violations. Selected text was not
verified in observe-external mode. Earlier attempts stopped at Windows foreground
prerequisites and were not counted as passing command tests.

Two additional settings regressions verify migration without credential changes
and atomic validation of startup/reporting preferences.

The 0.1.85 Windows installer and update metadata passed version/size/SHA-512 and
blockmap checks. The packaged native wake helper loaded the bundled CPU model,
decoded silence and exited cleanly. Twelve packaged backend/config/preload and
compiled renderer files were compared with current source/build and matched.
The 0.1.85 packaged UI/PTY/setup smoke also passed at
`.tmp/orchestrator-smoke/1788645892728-28888/`, including the Settings footer and
in-app indicator without creating a native audio window while disabled. Installer:
`release/vibeTerminal-Setup-0.1.85.exe`.

No physical microphone or authenticated live speech request is represented by
these tests. Synthetic input and scripted provider responses establish the
application path; audible naturalness and a user's acoustic environment remain
separate acceptance checks. No user conversations, credentials, running terminal
sessions, or installed application files were changed by the tests.

## First-use permission follow-up (0.1.86)

The combined backend suite now passes **259 tests**. Added checks cover remembered
consent, Not now, concurrent requests, aborted/late answers, denied OS access,
background startup without popups, explicit Windows settings navigation, and
blocking capture before consent. Frontend tests verify microphone refresh cannot
call `getUserMedia` after denial and releases its temporary stream after allowance.

Isolated Electron QA passed at
`.tmp/voice-experience-smoke/1788646408968-51348/`. Its held native-dialog spy
verified the parent window, message/buttons, and no audio window/helper/capture
before Allow. Subsequent Off/On reused the saved grant without another prompt.
The dialog response and OS permission status were scripted; this run does not
claim to have visually tested a real native permission dialog or modified OS
privacy settings. The command follow-up stopped at its external-foreground
prerequisite; the earlier passing command run remains separate evidence.

The 0.1.86 installer, metadata/hash/blockmap, and packaged native wake helper passed
verification. Seven changed permission/backend/renderer files matched current
source/build. The packaged UI/PTY/setup smoke passed at
`.tmp/orchestrator-smoke/1788646535210-44004/`. The current installer is
`release/vibeTerminal-Setup-0.1.86.exe`; the installed running app was left alone.

The popup uses Electron's native `dialog.showMessageBox`. It is app consent;
Electron's `askForMediaAccess` native OS prompt is macOS-only. Windows desktop
microphone access remains subject to its privacy settings. See
[Electron system preferences](https://www.electronjs.org/docs/latest/api/system-preferences)
and [Microsoft desktop app permissions](https://support.microsoft.com/en-us/windows/windows-desktop-apps-and-privacy-8b3b13bc-d8ff-5460-8423-7d5d5c1f6665).

## Spoken response repair (September 5, 2026)

The prior speech request sent `response_format: wav`, while the current
[OpenRouter speech API](https://openrouter.ai/docs/guides/overview/multimodal/tts)
documents PCM or MP3. Requests now use PCM and decode signed 16-bit samples using
the response's rate/channel metadata. Missing or invalid metadata fails with
spoken local feedback, without guessing playback parameters.

Wake capture now counts speech already present in its pre-roll buffer. Short
commands spoken before detection completes therefore reach transcription instead
of being discarded as silence. Empty, wake-only and punctuation-only transcripts,
and recordings with no detected speech, play “I didn't catch that. Say Hey Vibe
and try again.” Every explicit attempt gets feedback. Empty answers to pending
agent questions repeat the question and retain answer routing. Silence still
closes the bounded answer window.

Bundled fixed recordings cover network/provider failures, local request failures,
busy requests, spending limits, rejected answers and speech failures. They need
no cloud speech request and follow mute/cancel rules. Background alerts retain
their cooldown and defer during active voice turns. A failed playback
acknowledgment is reported as a failure, without recursive fallback attempts.

Verification: 289 backend tests, frontend voice smoke, asset validation and the
production build passed. Parent reviewed the diffs and isolated Electron evidence
at `.tmp/voice-experience-smoke/1788650479349-38068/`: WAV transcription to relay to
PCM response, plus empty transcription to local spoken retry, each with renderer
acknowledgment. No cloud speech was requested for the retry. Provider responses
and microphone input were scripted; output was zero-gain. Physical microphone,
audible playback and authenticated provider behavior remain unverified. These
fixes are included in the v0.1.88 release. Installed applications receive them
through the normal Check for update, Update and Restart flow.
