# Orchestrator and workspace redesign

See [the harness review](orchestrator-harness-review.md) for the tool map, title
resolution, single-conversation context, edge cases and verified limitations.

The app-wide Orchestrator is a user-command relay. It reads current activity,
summarizes observations, routes the user's instructions, and brings structured
agent questions back to the user. It does not decide answers, change priorities,
invent assignments, or grant itself authority from terminal output.

For the reading/voice follow-up, see [progressive context and local error audio](orchestrator-context-and-audio.md).

## Setup

1. Open **Workspace settings → Orchestrator & voice**.
2. Enter your own OpenRouter key. Keys are encrypted through the OS; the
   optional session-only setting keeps a new key in memory instead.
3. Load models, choose a tool-capable model, save, and test the connection.
4. Enable **Orchestrator** beside the version in the top-right corner.
5. Enable the microphone in the desktop overlay to use **Hey Vibe** or **Talk now**.

The application starts with Orchestrator off. Previously saved connections are
validated without running an inference. Missing microphone access does not
prevent typed commands. Turning Orchestrator off cancels its pending requests and
voice listening; existing terminal agents continue running.

Each user has their own credentials, model settings, preferences, saved setups,
and overlay position. Documents is resolved through Electron's OS folder API,
including redirected/OneDrive locations. No developer-specific path is required.

## Examples

- `What is Codex in Budget Tracker doing?`
- `Tell Codex in Budget Tracker to rerun the tests.`
- `Tell Worker A: explain why deleting the production data is a bad idea.`
- `Create project Budget Tracker in Documents and start Codex there.`
- `Find my previous Codex conversations in Budget Tracker.`
- `What did the saved conversation about the login screen discuss?`
- `Resume Codex conversation "Review payment flow".`
- `Save this setup as Frontend work.`
- `Launch setup Frontend work.`
- `Remember that I prefer concise updates.`

An explicitly identified session can become the target of a follow-up such as
`Tell it to rerun the tests`. The binding includes the launch generation; a
restart cannot silently redirect the old request. Relay payloads preserve the
whole explicitly supplied instruction, including qualifiers. Ambiguous targets
or command shapes are rejected or require clarification.

## Workspace UI

The theme uses neutral black/charcoal surfaces and grayscale controls, including
the mic overlay. Small semantic status indicators and code/terminal colors retain
their meaning. The board remains central. The sidebar includes project creation/opening and
session navigation. Task headers expose maximize, close, and an accessible menu
containing split, duplicate, resume, restart, and related controls. Existing
placement, snapping, Shift-swap, split minimums, and PTY fitting remain in use.

The empty session board shows every terminal/agent launcher with equal placement,
its actual name and a short description. Missing-tool detection is a hint; users
can still try launching through their shell. New session in the toolbar opens the
same launcher catalog. Without a folder, the start screen offers Open project,
New project and Multi mode.

The dock contains Orchestrator, History, Activity, Changes, Files, and Setups.
Drag the centered grip above its tabs up/down to adjust its height, all the way
down to its collapsed tab bar. Pull upward to reopen it continuously. The grip also
supports Up/Down arrows (Shift for a larger step), Home/End bounds, Enter to
collapse/expand, and double-click to reset. Height persists as a local UI
preference and adapts to window size while reserving space for the session board.
Collapsed state also persists. Sidebar projects can be reordered using their
grips, or Up/Down arrows on a focused grip; project order persists without changing
the active project or its running sessions.
The conversation has a visible vertical scrollbar and shows all retained messages;
incoming updates follow the bottom only when the user is already there. Changes
provides staged/working-tree previews and an explicit review marker for the
observed change-list snapshot. That marker is not a test result or proof of
correctness. Refresh changes to inspect subsequent edits. Binary/large previews
and incomplete observations are labeled.

Saved setups are versioned configuration recipes with fresh session identities.
They exclude runtime observations, approval IDs, credentials, and conversation
resume IDs. Opting into current drafts saves them as starting drafts; loading
stages them for review and explicit sending. Removed Aider recipes retain a
migration marker and become paused shells rather than running obsolete commands.

Handoffs freeze selected output and file references alongside the user's exact
instruction. **Use recent output** reads the selected source generation. Editing
the source selection cancels stale reads. Staging never sends bytes to a terminal.

## Harness and ownership

- `backend/orchestrator.cjs` owns the OpenRouter loop, activation/cancellation
  epochs, observational monitoring, request state, receipts, and explicit memory.
- `backend/orchestratorIntegration.cjs` composes standalone runtime snapshots and
  the existing Fusion/Open Fusion hosts; it bridges app actions and acknowledgments.
- `backend/terminalObservation.cjs` interprets live terminal output with headless
  xterm. History consists of bounded display samples, not a complete transcript.
- `backend/orchestratorPolicy.cjs` binds action permission and complete payloads
  to the current user command. Recent conversation and terminal output are data.
- `frontend/sessionDrafts.ts` keeps drafts and revisions in RAM independently of
  mounted pane components.

The standalone runtime remains the owner of identity, provider observations, and
shell/agent/turn separation. Metadata refresh time is not actual activity time.
The relay facade tracks meaningful output/activity separately. Its observational
timer defaults to 30 seconds, skips unchanged work, and does not execute tools
from model monitoring responses.

An action records queued/submitted/written/resolved/rejected/unknown outcomes as
supported by its adapter. PTY `written` means transport acceptance, not that an
agent understood the prompt or completed the work. Unconfirmed writes are not
automatically repeated. New action targets require the captured generation.

### Saved conversations

History searches existing provider-owned conversations in known workspace folders.
The UI supports provider/folder filters, title or ID search, pagination, transcript
excerpts, and explicit opening. The relay uses the same service through
`list_conversations`, `read_conversation`, and `resume_conversation`.

Native readers cover Codex, Claude (global/custom), Cursor, Gemini, Kimi/custom,
Qwen, and OpenCode. Fusion uses its planner's native store; Open Fusion keeps its
app-owned OpenCode home and migration cutoff. OpenCode prose comes from bounded
CLI export. Listing/reading runs in a lazy hidden child process, so filesystem
scans do not block Electron's main thread. Neither path creates a new archive.

Opaque in-memory references bind provider, original home, folder and native ID.
Every read/open revalidates the reference. The model cannot provide an arbitrary
transcript filename, substitute another chat, or infer a custom provider profile
from a shared home. Unknown custom-profile ownership requires the original
configured pane. User commands must identify one exact title or ID; ambiguous
matches need a provider/folder qualifier or the History selection control.

Opening reveals a matching active pane, resumes a matching paused/confirmed-exited
pane, or creates a new pane. It does not replace an unrelated live conversation.
A synchronous reservation prevents duplicate opens before React commits. The
receipt says `resume_requested`; actual launch/native output is separate evidence.
Open Fusion retains its model setup gate. Fusion uses its existing launcher model
defaults where historical model settings are unavailable.

Directory queries search titles/IDs/folder names. Search text in a selected
conversation scans native user/assistant prose locally. Reads return pages, with
Load earlier and search-location cursors preserving access to older content. Listing considers
at most 64 provider/folder scopes per request; omitted scopes are reported, and a
provider/folder filter narrows the search. Individual JSONL records, legacy JSON and OpenCode
exports over 8 MiB return an explicit limit rather than pretending to be complete.
Plain shells have current captured display history, but no native agent chat
archive to resume.

### Background prompt delivery

Structured Fusion/Open Fusion hosts support acknowledged task/steer/question
routes. Plain shells support explicit terminal commands. All supported standalone
agent providers use the same guarded PTY adapter: stable generation-bound idle
state plus a live root agent PID can permit a fresh transport check even after a
long idle period. The old five-second inactivity cutoff has been removed.

A busy/pending agent queues the exact prompt in RAM (50 total entries maximum,
120-second readiness wait). Observed readiness drains the queue in order;
unknown input state or expiry preserves a draft. Pending permissions/questions
are never answered by a new task. Stopped sessions are reported as not running.
Submission reservations and per-generation locks prevent two prompts from using
the same old idle observation. Cancellation before dispatch prevents the write;
after dispatch the final receipt retains the actual acknowledgment or unknown
outcome. No automatic interrupt or retry is performed.

The adapter uses host IPC and PTY writes, with no clipboard, system keystrokes,
renderer paste/focus, or main-window activation. The main renderer continues to
handle workspace commands while backgrounded. A user-requested open/reveal can
change the app's selected pane internally; bringing the app to the foreground is
a separate explicit overlay control.

Multiline native prompts use bracketed paste only when the terminal has enabled
it; otherwise they are staged. Unfinished manually typed input is preserved: a
background prompt stages instead of appending to it. Terminal-generated focus and
device reports do not set or clear that protection. A generation or live shell alone cannot prove
that the foreground input is an agent composer. PTY `written` remains transport
acceptance, not model consumption or successful task completion.

Full spoken question/choice routing is implemented for structured Fusion and
Open Fusion interactions. Arbitrary terminal TUIs may expose only activity or
visible text; unsupported question menus require interaction in their terminal.
The relay can still read and summarize their captured screen on request.

Fusion preserves question IDs and option arrays and accepts distinct answers per
question. Open Fusion retains its ordered answer arrays. Both use request
revision/generation checks and submission locks. Replayed/resolved requests do
not become new announcements. Existing provider approval policies remain intact.
Open Fusion also retains completed answer prefixes, so moving between mouse and
voice advances the same question request rather than repeating earlier answers.

## Voice

Wake detection is local, using the pinned English sherpa-onnx GigaSpeech keyword
model in a hidden child process. The process validates model hashes and bounds
its frame queue. Mute/disposal terminates it. If wake detection fails, manual
capture remains available where microphone and cloud settings are usable.

Activated audio is held in memory and sent to OpenRouter's transcription
endpoint. The default is `openai/whisper-large-v3-turbo`. The user-selected
Orchestrator handles the recognized text. Spoken replies use
`openai/gpt-4o-mini-tts-2025-12-15`, with 24kHz signed 16-bit mono PCM playback.
Other raw-PCM TTS models are refused until a compatible format adapter is added.

There is no MP3/file-save workflow. Audio chunks are ordered, bounded, and
cancelled by playback identity. Wake detection pauses during playback. Voice is
turn-based; a stop-speaking control is available. An agent question opens a
15-second answer window. Choices map literally from labels or numbers; custom
answers use the announced format. Permission answers use explicit `allow once`,
`allow always`, or `reject`; `yes` never becomes an expanded permission.

The overlay shows listening/transcribing/thinking/speaking/error states without
automatically stealing focus. It shares one controller with the dock and has a
narrow preload bridge. Monitor changes clamp its saved position to a work area.
It remains available when minimized and closes with the application.

OpenRouter transcription, orchestration, and speech all use the user's key and
are billed separately by OpenRouter. The optional spending limit stops further
requests based on reported session usage; an in-flight request can exceed the
remaining amount. Unknown provider costs are not a prepaid guarantee.

## Storage and validation

Settings, encrypted credentials, explicit preferences, saved setups, and selected
workspace configuration persist under the current user's app data. New relay
messages, captured terminal history, handoff drafts, and microphone audio do not
become a permanent archive. Existing engine-owned transcript storage is separate.

Useful commands:

```text
npm run test:orchestrator
npm run smoke:frontend:workspace-setups
npm run smoke:frontend:orchestrator-history
npm run build
npm run smoke:electron:orchestrator
npm run smoke:electron:orchestrator-command
npm run smoke:electron:terminal-board
npm run prepare:voice
node scripts/backend/voice-packaged-smoke.cjs
```

The tests include mocked cloud transport, real PTY fixtures, native keyword
detection with synthetic speech, an isolated Electron workflow, and packaged
wake-helper loading. Real microphones, varied acoustic environments, and live
OpenRouter account/model behavior require separate acceptance checks.

Packaging includes `vendor/voice` and unpacks sherpa native modules. If the global
Codex version differs from the app's pinned schema, use
`VIBE_CODEX_BIN_SEARCH_ROOTS` to point preparation at a matching local payload;
do not replace the user's global CLI just to package the app.
