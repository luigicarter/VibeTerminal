# Progressive context and local error audio

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
in effect. Background alerts retain cooldown; every explicit voice attempt gets
feedback, without a recursive cloud request to announce an error.

Speech uses the supported Kokoro English voices through OpenRouter. The app
requests PCM and validates response rate/channel metadata, frame alignment,
duration and response size before playback. Framed WAV responses remain compatible.
Preview works while the mic and orchestrator are off and waits for
actual renderer playback completion. It does not enable capture. Missing or
failed playback acknowledgments are reported as failures.

Background monitoring is opt-in. Credit/authentication failures pause automatic
monitoring until successful explicit validation; other failures back off. Model
configuration, speech, and microphone readiness are separate checks.

## Verification

The v0.1.89 live History follow-up passes all 37 release checks, including the
289 backend tests and deterministic refresh/pagination/visibility race checks.
Isolated Electron QA at `.tmp/history-live-smoke/1788651527561-52252/` appended
and edited a real fixture rollout while History stayed open, reconstructed
54,029 Unicode characters, preserved the browsing scroll position, and verified
that closing the view stopped reads. No provider request or voice activation
occurred. The parent inspected the code, assertions, artifacts and screenshot.

The targeted suite passes 207 tests, including context budgets, progressive pages,
source revisions, Unicode reconstruction, cursor rejection, error classification,
offline assets, cancel/mute/cooldown, partial/empty TTS failures and billing pause.
Frontend merge/paging and TypeScript checks pass.

Real isolated Electron QA at `.tmp/audio-context-smoke/1788634805105-33592/`
reconstructed a 54,476-character Unicode message after three earlier-page loads,
searched/jumped to an early marker, returned to Latest and verified the original
file hash was unchanged. A scripted 402 passed through the real relay/IPC path,
scheduled 21 local PCM buffers and received the real player's playback-complete
acknowledgment. No cloud speech request occurred. Repetition suppression and mute
were checked against actual scripted upstream failures.

The microphone was stubbed and playback used a zero-gain node. These checks prove
the pipeline, not audible speaker quality, microphone hardware, or live account
behavior. Parent review inspected source, test assertions, artifacts and UI
screenshots.
