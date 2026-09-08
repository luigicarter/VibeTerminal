# Progressive context and local error audio

Ordinary spoken replies and agent result reports use a separate, natural TL;DR.
The model chooses the detail needed to explain the outcome, checks, and blockers;
there are no fixed sentence, word, or character caps on the spoken summary.
Full written replies remain in the conversation. The normal voice response
includes both written text and `speechText` in the same model call. If the model
omits the spoken summary, one tool-free summary attempt supplies it. App-generated
status replies and automatic result summaries reuse their existing text without
another model call. Empty or failed summaries produce a brief unavailable-summary
message; raw result excerpts remain available only in writing.
Clarification and permission questions retain their wording and answer identity.
Markdown is converted to spoken prose. UI task labels and request excerpts are
never prepended to speech, even
when other requests are paused or awaiting answers. Responses can name a terminal
or project explicitly when the listener needs that context.

With hands-free voice enabled and its detector ready, **Hey Vibe** interrupts
speech preparation or playback and starts capture for the next command. It
cancels obsolete queued speech, preserves a current question's answer route,
and does not cancel terminal work. Space remains available for interruption.

The model budget limits a copy of the material sent to the LLM. It does not
rewrite native conversations, shorten loaded History UI pages, or reduce the
terminal's existing user-facing output retention.

## Reading without filling the model window

- `read_session` starts with a small recent screen/chat excerpt. Standalone
  terminal reads can follow `nextBeforeSequence` to earlier retained display
  samples. Their generation, observed time and eviction gaps remain explicit.
- `list_conversations` searches titles and identities. `search_conversation`
  scans the selected native conversation locally and returns small matching
  user/assistant snippets with read cursors. It does not upload the full file.
- `read_conversation` follows opaque cursors through older chronological pages.
  Long messages are split into fragments with message IDs and UTF-16 ranges.
  The UI merges adjoining/overlapping fragments without losing characters.
- History provides **Load earlier**, **Search text**, **Continue search**,
  **Jump to match** and **Latest**. Loaded messages and accumulated search
  matches remain available independently of the model's context window.

The selected History chat checks local provider history about once a second
while the view is open and the document is visible. At the bottom, new saved
messages appear automatically. Scrolling up, loading earlier messages or jumping
to a search result preserves that snapshot and position; **Conversation updated**
offers a return to the latest messages. **Latest** resumes following new messages.
This reflects messages as the provider saves them, rather than unsaved streaming
tokens. No model or speech request is needed to refresh History.

Refresh reads a fresh source revision and keeps existing content visible until
the replacement is ready. It does not merge fragments from different revisions.
Selection changes, explicit reads, visibility changes and closing the view
invalidate late refresh results. Cursors and search matches tied to a previous
revision are discarded when a new snapshot is displayed.

Every brain/monitor request passes a serialized UTF-8 byte guard. The model's
advertised context length reserves output and protocol space; an application
ceiling of 48,000 input bytes applies. This is deliberately conservative, not an
exact tokenizer calculation. An unknown context window uses a conservative
fallback. The current user instruction, authority rules and tool schema are
never silently shortened; impossible fits fail locally before an API call.

Read allowances reset for each model/tool round. There is no lifetime source-read
quota that makes older conversation text inaccessible after a few excerpts.
Older raw read results can leave the model context as new pages arrive, while
their identities, coverage and continuation locations remain available. Effect
receipts and tool-call/result pairing are preserved. Duplicate pages are
recognized using source revisions/ranges; changed output is readable again.

Cross-request bookmarks advance only after a model response confirms that the
request containing the page reached the model. A local context refusal or failed
API call cannot advance past a page the model never received. The existing
per-request tool-round bound remains; subsequent requests can continue from a
bookmark. It is a bounded operation, not an unlimited background reading job.

## Source limits stay explicit

History cursors bind the reference, provider/home, folder, native ID and file
snapshot. A modified or growing transcript invalidates old cursors and asks for a
fresh read rather than mixing positions from different versions. Local scan
operations use a roughly 2 MiB/one-second work window plus the current bounded
record. Individual JSONL records, legacy JSON files and OpenCode exports have an
8 MiB reader limit; unsupported data reports an error instead of silently
claiming a complete read. Search coverage describes decoded human user/assistant
prose. Live terminal samples are not a complete native conversation archive.

## Error feedback without cloud speech

Runtime errors and missed speech use bundled fixed spoken recordings, including
a retry prompt for empty transcription and recordings with no detected speech.
The mic and Settings identify whether transcription, the assistant request, or
speech failed. A spoken-reply failure does not imply that an action was rejected.
HTTP status and safe classified details remain available; raw provider bodies and
keys are never spoken. Mute, cancellation and deferred background errors remain
in effect. Background alerts retain cooldown. Wake-only transcripts use visible
no-command feedback, while provider/relay failures and missed manual speech use
the corresponding local clips. Short uncertain automatic speech also ends with
local retry feedback without an upload, preserving any pending question. Manual
start/flush failures are reported by backend state scoped to the matching hold;
stale failures cannot overwrite a later recording. The
[voice audit](orchestrator-voice-deep-dive.md) records the remaining limitations.

Speech uses the supported Kokoro English voices through OpenRouter. The app
requests PCM and validates response rate/channel metadata, frame alignment,
then streams the first approximately 100 ms before download completion. Later
chunks contain at most one second; duration and byte limits apply throughout.
Incomplete final frames or stream/playback errors cancel the remaining reply
without replaying speech already heard. WAV containers remain fully buffered and
validated. Unlabeled responses are inspected for a WAV signature before choosing
buffered decoding or native PCM streaming.
Preview works while the mic and orchestrator are off and waits for
actual renderer playback completion. It does not enable capture. Missing or
failed playback acknowledgments are reported as failures.

The renderer reports `playbackStarted` with its reply ID at scheduled
AudioContext output time, not physical speaker audibility. Playback errors also
carry the reply ID, and completion follows actual source endings. Stale replies
cannot stop newer speech or open an answer window. Private timing diagnostics
link capture/recording IDs to STT completion and request IDs to model, tool,
first-effect, final-text, TTS and playback stages. Actual provider calls have
separate call IDs; synthetic replies do not count as model calls.

Fully specified unprompted terminal creation can execute directly after intent
validation. Completed operator scopes reuse their validated finish summaries
without an extra model response, retaining queued/pending-result distinctions.
Late delivery failures or uncertain outcomes require explicit reporting instead
of a synthetic success. Independent terminal deliveries share four transport
slots with one in flight per generation; inventory readers no longer wait on
those acknowledgments. Concurrent inventory reads coalesce, while a workspace
mutation invalidates older reads.

Background monitoring is opt-in. Credit/authentication failures pause automatic
monitoring until successful explicit validation; other failures back off. Model
configuration, speech, and microphone readiness are separate checks.

## Verification

The initial spoken-summary and wake-interruption change passed 977 backend/Orchestrator/
voice tests, the renderer build, frontend voice smoke, capture checks and PCM
player tests. Parent review inspected the code, assertions, and native-model
report at `.tmp/voice-wake-interruption/1788832362775-53756/report.json`.
Both speech preparation and streaming cases recognized the synthetic wake,
cancelled speech on that detection, and captured one subsequent command.
Cloud endpoints and playback were mocked; physical microphone, loudspeaker echo,
and live-provider behavior were not tested. These changes are in source and the
local build; this work did not update the installed release.

The follow-up removing prose-length caps passed 1,090 backend/Orchestrator/voice
tests. It verifies model-chosen summaries beyond the former limits, intact TTS
input beyond 4,000 characters, same-response summaries without an extra model
call, and current delivery evidence replacing an unsupported spoken claim.
The final log is `.tmp/voice-summary-no-cap/1788834202388/backend-tests-final.log`.
Wake interruption and request cancellation regressions remain included.

`npm run bench:orchestrator:latency -- --baseline <snapshot-root> --delay-ms 50`
compares an optional source snapshot with the current code using scripted
providers and disposable adapters. It records actual model-call counts,
first-effect/final-response timings, held-acknowledgment behavior and PCM before
EOF. Its delays are synthetic; these are not live-provider speed measurements.
`npm run test:frontend:voice-pcm` covers renderer ordering and playback completion.

Run `npm run test:orchestrator` for context budgets, progressive pages, source
revisions, Unicode reconstruction, cursor rejection, error classification,
offline assets, cancel/mute/cooldown, partial/empty TTS failures and billing pause.
`npm run smoke:frontend:orchestrator-history` checks renderer history behavior;
`npm run smoke:electron:context-history` checks real UI pagination, Unicode,
search/jump and source preservation without voice or provider activation;
`npm run smoke:electron:voice-experience` covers current playback/capture behavior.
`npm run typecheck` checks the TypeScript surface. Commands describe available
coverage, not a claim that they were rerun for this documentation consolidation.

Historical isolated Electron QA from v0.1.89 at
`.tmp/history-live-smoke/1788651527561-52252/` appended
and edited a real fixture rollout while History stayed open, reconstructed
54,029 Unicode characters, preserved the browsing scroll position, and verified
that closing the view stopped reads. No provider request or voice activation
occurred. The parent inspected the code, assertions, artifacts and screenshot.

Earlier isolated Electron QA at `.tmp/audio-context-smoke/1788634805105-33592/`
reconstructed a 54,476-character Unicode message after three earlier-page loads,
searched/jumped to an early marker, returned to Latest and verified the original
file hash was unchanged. A scripted 402 passed through the real relay/IPC path,
scheduled 21 local PCM buffers and received the real player's playback-complete
acknowledgment. No cloud speech request occurred. Repetition suppression and mute
were checked against actual scripted upstream failures.

The microphone was stubbed and playback used a zero-gain node. These checks prove
the pipeline, not audible speaker quality, microphone hardware, or live account
behavior. Parent review inspected source, test assertions, artifacts and UI
screenshots. See the [current voice deep dive](orchestrator-voice-deep-dive.md)
for subsequent provider evidence and remaining physical-audio verification limits.
