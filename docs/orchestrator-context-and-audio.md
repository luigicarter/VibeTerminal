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

## Error announcements without cloud speech

Seven short English WAV recordings ship in `vendor/voice/alerts`: credits,
authentication, rate limit, upstream/provider failure, connection failure,
timeout and rejected request. They are generated offline during maintenance and
played as 24 kHz mono signed-16-bit PCM through the existing audio player. Runtime
does not invoke Windows speech synthesis or OpenRouter TTS for these alerts.

The credit recording says: “OpenRouter reports insufficient credits. Please check
your balance or API key spending limit.” This avoids claiming the balance is
exactly zero. Provider/BYOK balance errors get the upstream recording rather than
an incorrect statement about the user's OpenRouter account.

Classification follows the documented HTTP/error-envelope distinctions:
401 authentication, 402 payment/credits, 403 rejected/forbidden request, 408
timeout, 429 rate limit and upstream 5xx failures. Responses that contain an error
inside HTTP 200, broken/empty speech streams and transport failures are handled
too. Raw provider error bodies and keys are never used as announcement text.
See the [OpenRouter response error reference](https://openrouter.ai/docs/client-sdks/typescript/api-reference/responses).

Alerts respect voice mute and cancellation. The same category is suppressed for
60 seconds to avoid repetition. Background monitoring alerts wait until an active
recording/reply finishes; cancelling also invalidates deferred announcements.
Billing/authentication errors pause automatic model monitoring until a successful
explicit retry/connection validation. A failed retry does not clear that pause.
Other monitor failures have a retry delay. Individual user commands remain
explicit retry opportunities.

Asset hashes, format, size, duration and non-silent PCM are verified before
packaging and by the runtime loader. Missing/corrupt assets leave the normal text
error available; they never trigger another cloud request to speak the error.

## Verification

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
