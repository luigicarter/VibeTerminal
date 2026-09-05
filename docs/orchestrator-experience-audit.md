# Orchestrator experience audit

Date: 2026-09-05. Scope: investigation of the reported voice failure, settings,
floating window, session sidebar, bottom dock, and unsolicited reports. This
document records findings and a corrective design; it does not implement or
claim to ship the redesign.

Follow-up: the corrective implementation is now in the workspace. See
[the implementation verification](orchestrator-voice-fixes.md) for current
behavior, performance measurements, and test boundaries. The findings below
describe the original 0.1.84 behavior, not the corrected code.

## Required experience

The user's stated requirements are a small glowing microphone, listening for
"Hey Vibe" while enabled, natural spoken replies, and a usable way to dismiss
the overlay. The left session list and bottom Orchestrator slider/bar are unwanted.
The intended interaction resembles Siri: enable once, speak the wake phrase,
give a request, hear a concise answer, and return to waiting for the wake phrase.

## Findings

### 1. The configured speech model is unavailable in the current public catalog

The installed settings select `openai/gpt-4o-mini-tts-2025-12-15` and `alloy`.
That same model is the app default. On this audit date, unauthenticated public
OpenRouter checks returned:

| Check | Result |
| --- | --- |
| `/api/v1/models?output_modalities=speech` | HTTP 200; 18 models; configured TTS ID absent |
| `/api/v1/models/openai/gpt-4o-mini-tts-2025-12-15/endpoints` | HTTP 404, Not Found |
| `/api/v1/models/openai/gpt-4o-mini-tts/endpoints` | HTTP 404, Not Found |
| `/api/v1/models?output_modalities=transcription` | Configured `openai/whisper-large-v3-turbo` present |
| `/api/v1/models` | Configured `z-ai/glm-5.3-flash` present with tools support |

Public evidence: [speech catalog](https://openrouter.ai/api/v1/models?output_modalities=speech),
[configured speech model endpoints](https://openrouter.ai/api/v1/models/openai/gpt-4o-mini-tts-2025-12-15/endpoints).
These are catalog lookups, not an authenticated speech request or an account
diagnosis. Availability can change.

`backend/voiceController.cjs:192` also refuses every other TTS model locally,
because the player assumes 24 kHz mono signed 16-bit PCM. Therefore choosing a
currently listed speech model in Settings is not a working workaround.
`backend/orchestratorSettings.cjs:4` defines the unavailable default.

This is a strong candidate for the reported failure: the app records a successful
text answer before trying to speak it (`backend/orchestrator.cjs:233`). Speech
can then fail independently and trigger the generic local rejection recording.
The relay also ignores speech's returned failure and still returns `ok:true`.
The original HTTP response was not supplied, so that specific causal chain is
not conclusively established for the user's incident.

### 2. The robotic announcement is a separate Windows-generated recording

`vendor/voice/alerts/manifest.json:61` contains the exact announcement:
"OpenRouter rejected the request. Please check your model and settings."
The next line identifies `Microsoft Zira Desktop`. All seven error clips were
generated using offline Windows System.Speech
(`scripts/dev/generate-error-audio.cjs:15`). They bypass the selected cloud voice.

`backend/openRouterErrors.cjs:26` collapses otherwise-unhandled 4xx statuses,
including malformed requests, forbidden requests, missing endpoints/models, and
validation errors, into the same category. The original reason is discarded.
`backend/voiceController.cjs:67` does not use the supplied operation to distinguish
transcription, orchestration, or speech failures. An inability to read an answer
aloud can therefore sound like refusal of the user's instruction.

### 3. The overlay really is a floating control window, with broken dismissal

`backend/orchestratorIntegration.cjs:371` creates a 420 x 300 opaque,
always-on-top window. `frontend/voice/overlay.css:17` makes its header draggable.
The component contains branding, model name, status, transcript, question cards,
and footer controls (`frontend/VoiceOverlay.tsx:40`). The mic animation changes
opacity; it does not implement the requested glow.

The X calls only `api.setListening(false)`. It never hides or closes the window.
The collapse button sends `collapse`, while the main process reads `collapsed`
(`backend/orchestratorIntegration.cjs:425`). Content disappears but the large
native window remains. The native expanded height would also be 420, inconsistent
with its initial 300.

There is an architectural coupling underneath this: the overlay renderer owns
microphone capture and audio playback. Destroying it stops listening
(`backend/orchestratorIntegration.cjs:384`). A background voice assistant needs
an explicit distinction between hiding its visual indicator and stopping audio.

### 4. Enabling Orchestrator does not enable "Hey Vibe"

`backend/orchestratorIntegration.cjs:391` enables the relay and shows the overlay;
it does not start listening. The user must separately enable the microphone.
Both controllers start off, and voice-enabled preference is not restored.
Settings misleadingly says the microphone beside the app version enables voice;
that control enables the relay instead.

Local wake detection exists and can return to listening after a reply
(`backend/voiceController.cjs:100`). The underlying mechanism is present, but the
activation flow does not match the requested single on/off experience. Wake
detection pauses during playback, so this is currently a turn-based pipeline,
not full conversational interruption while speaking.

### 5. Setup can say "Connection verified" while the selected model is unusable

Save persists key/model but invalidates readiness. The main toggle is disabled
until ready. The user has to infer a separate Test connection step.
Test uses saved settings rather than the values currently being edited.

`backend/orchestrator.cjs:244` checks account/key and the brain model catalog.
It can return `{ok:true, ready:false}` for a missing/invalid selected model.
`frontend/components/OrchestratorSettings.tsx:49` checks only `ok`, displaying
"Connection verified." Neither transcription nor speech is validated.

Voice settings combine transcription and speech entries in one datalist and
allow arbitrary IDs, despite the single-model playback restriction. Save
behavior is inconsistent: some fields need Save, others persist on blur, and
microphone selection persists immediately. Every configure cancels current
work; a microphone change does not update the active capture device until
listening restarts. Model changes disable the relay without consistently
stopping microphone capture. See `OrchestratorSettings.tsx:48`,
`backend/orchestrator.cjs:257`, `backend/orchestratorIntegration.cjs:406`, and
`backend/voiceController.cjs:107`.

### 6. The pasted terminal summaries are automatic monitoring, not requested answers

Enabling the relay starts a monitoring timer, defaulting to 30 seconds, with no separate opt-in
(`backend/orchestrator.cjs:113`, `:263`). The first scan considers all directory
entries changed, including idle and paused ones. Subsequent activity timestamps
can trigger more scans. Up to 12 sessions are read per batch.

Paused session placeholders have no decoder, yet the monitor tries to read them.
`backend/terminalObservation.cjs:104` returns the exact "No live decoder for this
generation" text seen in the user's output. That internal result is sent to the
model to summarize. A tracked terminal displaying this conversation is also
eligible, explaining how the user's complaint became a report. This does not
show access to unrelated conversations outside the tracked workspace.

Normal monitor summaries are text-only. Monitor API failures can separately
trigger spoken error clips. The UI labels all non-user messages "Orchestrator"
and ignores `origin: 'monitor'`, blending reports with conversational answers
(`frontend/components/OrchestratorPanel.tsx:156`). Monitor messages also enter
recent conversation context, affecting subsequent replies.

The monitor has a 350-output-token limit and does not check `finish_reason`
(`backend/orchestrator.cjs:101`). That creates a concrete risk of the unfinished
sentences shown in the pasted output; original response metadata is needed to
prove why those specific messages ended there. Casual greetings also use the
full operational prompt, which can produce the unnecessary "no sessions were
touched" explanation.

### 7. Ordinary spoken instructions can fail the command grammar

`backend/orchestratorPolicy.cjs:16` and `:65` require particular leading verbs
and a colon, quoted payload, or "to" after the target. Offline reproduction:

| User wording | Authorization |
| --- | --- |
| Tell Worker A to fix the bug | Accepted |
| Tell Worker A: fix the bug | Accepted |
| Tell Worker A fix the bug | Rejected |
| I want you to tell Worker A to fix the bug | Rejected |

An LLM can understand the intent and request the correct tool, yet application
parsing rejects it. A tool authorization exception becomes a temporary model
result with no rejected-action receipt. The subsequent answer returns `ok:true`
even when the requested action failed (`backend/orchestrator.cjs:233`, `:237`).
The mock reproduced a rejected answer, zero effects, and an empty receipt list.

The correction should accommodate natural speech while retaining exact target,
complete payload, generation, and explicit authority checks. Removing those
checks wholesale would undermine reliable routing.

### 8. The sidebar and bottom dock are presentation, not routing requirements

`frontend/App.tsx:4817` mounts `SessionNavigation`, which duplicates session
navigation already available on the board. Backend routing independently uses
`allSessions -> relaySessions` (`App.tsx:4470`, `:4560`). Removing the visible list
does not require removing the session directory the assistant needs.

`frontend/App.tsx:5445` mounts the bottom `OrchestratorPanel`. It adds a resizable
six-tab workspace dock, defaulting to expanded, with a persistent bar even when
collapsed. Removing this always-visible UI should preserve access to any useful history,
file, changes, and setup actions elsewhere, and preserve their underlying data.
The user did not request deletion of those records or of running sessions.

## Corrective design and implementation order

1. Repair the speech configuration and adapter first. Use a currently available
   speech model/voice, validate its audio format and actual playback, and make
   unsupported saved settings recoverable. Preserve stage-specific, bounded,
   redacted diagnostics. Replace the robotic rejection experience with a clear
   short failure indication that does not misrepresent a completed action.
2. Centralize voice activation: one enabled state starts microphone capture and
   local "Hey Vibe" detection. Remember the user's enable/mute choice while the
   app is running and, if persisted, restore that explicit choice on launch.
   Keep waiting, recording, thinking, speaking, and error states coherent.
3. Replace the floating panel with a compact transparent glowing mic. Provide
   reliable mute/disable and dismissal controls; define hide versus disable
   explicitly. Keep capture/playback alive independently if the indicator is
   hidden. Do not require a transcript window or manual Talk now for normal use.
4. Remove the left session list and bottom orchestrator dock from the primary
   workspace. Preserve terminal targeting, current sessions, and saved data.
   Place optional diagnostics and secondary tools behind deliberate access.
5. Stop unsolicited monitoring reports by default. Read workspace information
   when the user asks. If monitoring remains available, make it explicit and
   restrict it to useful changes; paused decoder errors are not user updates.
6. Replace the fragmented setup with one coherent connect/save flow, supported
   model choices, microphone selection, and a voice check. Hide technical tuning
   behind advanced controls. Do not label account validation as voice readiness.
7. Improve natural-language command interpretation and expose truthful action
   outcomes. Keep everyday replies short; do not recite no-action receipts in
   response to greetings.

## Verification and acceptance boundary

The installed application and workspace are both version 0.1.84. Parent comparison
confirmed the installed orchestrator, integration, and voice controller match
source byte-for-byte; policy and error classifier match after CRLF normalization.
Only selected non-secret settings were inspected. No keys were decrypted or used,
no authenticated inference/audio requests were made, and the running app was not
modified or restarted. The parent also inspected an existing overlay screenshot,
the relevant implementation, and representative test assertions.

Focused existing suites passed: voice pipeline/assets/announcements/wake process
36/36; policy/relay/integration/delivery/OpenRouter errors 63/63; integration/provider
coverage 29/29. These groups overlap and are not a summed unique test count.
Mocks establish control flow, not current provider acceptance. The native wake
helper started, decoded silence, and disposed. Prior UI audio QA explicitly used
a stubbed microphone and zero-gain playback
(`docs/orchestrator-context-and-audio.md:100`), so it never established audible
voice quality or physical microphone behavior.

Acceptance for the correction must include an audible reply with the selected
live speech configuration; repeated physical "Hey Vibe" activations; automatic
return to wake listening; real mute/hide/close behavior; no unwanted session list
or bottom dock; no unsolicited idle reports; settings changes during activity;
truthful failures at each pipeline stage; and exact delivery to the intended
terminal without disturbing another pane. None of those future redesign checks
is claimed complete by this investigation.
