# Orchestrator implementation review and verification

Updated: 2026-09-05. Application workspace version: 0.1.81 (development changes;
not a newly published release).

## Review passes

The implementation was reviewed by subsystem and again as an integrated app.
Pre-existing terminal-runtime/provider/geometry changes were retained. Parent
review inspected source, interface wiring, test results, and captured UI output;
independent review supplemented those checks.

Issues found and corrected included:

- Model-selected prompt substrings could lose the user's qualifiers. Relay
  payloads now bind to the whole explicitly supplied text.
- Named in-flight commands could otherwise bind to a replacement generation
  after a runtime refresh. Authorization now uses the original session snapshot.
- Adapter steering uses `routing`/`steered`; uncertain steering does not trigger
  a second prompt through another route.
- Normal chat envelopes and question resolutions now retain launch identity.
- Voice question IDs are scoped by session, generation, request, and revision.
- Open Fusion completed question prefixes now live in the host and synchronize
  mouse and voice progress; stale revisions cannot overwrite them.
- Fusion single-choice answers normalize to its keyed array format.
- Closing panes releases new observation state. Cancellation terminates wake
  helpers and prevents delayed transcription/playback from causing new actions.
- Folder-opening validates that the target is a directory.
- Setup save errors and staged-input failures retain their actual failure state.
- Changes lists expand untracked directories into individual files.
- Stable scrollbar space preserves geometry when the dock changes height.

## Automated evidence

`npm run test:orchestrator`: **129 tests passed** at the final implementation
checkpoint. These execute production policy, settings, file, question, draft,
observation, integration, and audio helpers with mocked model transport.

The suite also exercises real Git and PTY fixtures, native keyword detection
against synthetic positive/negative speech, and the isolated native wake helper.
It covers multi-pane reused question IDs, partial GUI answers superseding a voice
question, old-generation rejection, cancellation, exact payloads, resource limits,
and fair monitoring across more than one batch of sessions.

Existing runtime, metadata, telemetry, launcher, persistence, board/split, input,
Fusion settings/adapter/parser, Open Fusion isolation/parser/custom-provider,
completion-gate, Git, update, and build-supervisor smoke checks passed during the
implementation. The split source-wiring assertion and Electron action-menu entry
were updated to follow the real redesigned overflow menu; geometry assertions
were retained.

The isolated Electron board test passed real PTY sizing, hidden titles, drag
preview/commit, explicit swaps, activity-popover positioning, and fixture lifecycle
transitions. The separate Orchestrator Electron test passed fresh-profile disabled
readiness, Documents project creation, sidebar selection, zero-byte draft staging,
acknowledged shell input/output, setup save/launch, explicit preference storage,
and desktop overlay loading with its restricted preload.

## History, background delivery and theme acceptance

The follow-up review covered neutral dark styling, native saved conversations,
background prompts, and end-to-end command routing. It corrected:

- Long-idle terminal delivery rejected by an arbitrary activity timeout.
- Relay writes bypassing runtime submission reservations.
- Duplicate writes while acknowledgment or the next turn is still unobserved.
- Cancellation reporting success after queued transport had already started.
- Unsafe multiline TUI input without bracketed-paste framing.
- Background input appending to unfinished human text; automatic xterm focus,
  DSR and DA reports now preserve rather than dirty that input marker.
- Stale/child process events overwriting a pane's root recipient PID.
- Shared custom Claude homes assigning an unproven provider profile to a chat.
- Kimi's current root transcript location (`agents/main/wire.jsonl`).
- Reopening an exited agent merely revealing its shell.
- Duplicate native chat ownership across pending React updates and Kimi variants.

The parent inspected the final native-history reader/process/host, delivery queue,
PTY/runtime changes, relay policy/integration, renderer launch logic, and CSS.
Corrections were followed by targeted checks. The final pass compared the combined
behavior with the requested relay-only authority and preservation of other work.

`smoke:electron:orchestrator-command` uses scripted OpenRouter replies, the actual
Electron/preload/relay policy path, a real PowerShell PTY, native Codex transcript
fixtures, and a PATH-isolated fake Codex executable. It verifies evaluated shell
output (not just command echo), wrong-payload/target rejection, cancellation,
list/read/exact-ID resume, internal selection preservation during sends, and the
History and mic overlay UI. A separate WinForms application retained Windows
foreground ownership, selected text and clipboard sequence across 18 samples
with zero observed violations in the final reviewed run.

Artifacts: `.tmp/orchestrator-command-smoke/1788581759340-41216/` contains
`results.json`, `history.png`, `overlay.png`, and `workspace.png`. The parent viewed
the screenshots and inspected results. Real command execution and resume argument
transport were verified; the fake Codex executable does not prove live Codex model
acceptance. The 26 provider integration cases exercise actual integration code
with simulated host acknowledgments for Fusion/Open Fusion plus all eight native
agent provider variants. They verify idle/busy routing, unknown steering, pending
permissions, stale generations, queues and staged outcomes.

The existing Electron orchestrator workflow and terminal-board geometry tests
passed again against the rebuilt renderer. Runtime, metadata/generation,
OpenFusion isolation, launch/persistence, terminal rendering and history helper
smoke checks also passed after the changes. The theme screenshots show neutral
black/charcoal chrome and a grayscale mic; semantic ANSI/status colors remain.

## Packaging and live-test boundary

Windows unpacked packaging succeeded using the existing pinned Codex 0.144.0
payload through `VIBE_CODEX_BIN_SEARCH_ROOTS`. The globally installed Codex version
was left unchanged. The packaged Electron process successfully loaded the wake
model/native runtime in its helper, decoded silence, and exited cleanly. The
new packaged history helper also passed startup and IPC with an empty isolated
scope. The final packaged Electron workflow passed using isolated user data
(`.tmp/orchestrator-smoke/1788581781701-35124/`).

No live OpenRouter inference/transcription/speech call or physical microphone
session was performed. Synthetic speech verifies the detector path, not every
accent, microphone, noise environment, or live latency. Arbitrary terminal TUIs
without sufficient recipient evidence use staged/manual interaction; structured
Fusion/Open Fusion question routing has the stronger contract.

See [Orchestrator](orchestrator.md) for setup, operating limits, and the main test
commands. Generated QA diagnostics and images are under `.tmp/orchestrator-smoke`,
`.tmp/terminal-board-smoke`, `.tmp/voice`, and `artifacts/`; they are not user data.


## Launcher and dock usability follow-up

The Fusion-specific empty-board action was replaced with equal launch cards for
all 12 existing profiles. The toolbar uses the same catalog and now says New
session. Initial project actions and Orchestrator setup/off messages describe
what their controls actually do.

The dock has a visible top drag grip, keyboard resize controls, double-click
reset, collapse/restore and persisted height. Its bounds retain usable board
space. All retained relay messages are scrollable; reading earlier messages does
not intentionally follow new output. Resizing never recreates terminal panes.

Build, workspace/dock geometry and App-runtime smoke checks passed. Parent review
inspected the components, pure geometry, CSS, test assertions and screenshots.
The Electron workspace-controls test passed at
`.tmp/workspace-controls-smoke/1788601461319-48108/`: all profiles in project/Multi
views, toolbar parity, real Terminal folder, pointer and keyboard changes, exact
terminal DOM/runtime/layout preservation, composer reachability, persisted height
and 1024x700 clamping. Every compact-layout card was independently scrolled into
view and hit-tested. Scroll stress used local layout text, not live provider
history. The full scripted-model command E2E also passed again at
`.tmp/orchestrator-command-smoke/1788601573612-48388/`.


## Title-aware harness review and full-collapse/project ordering

See [the complete harness review](orchestrator-harness-review.md) for the single
relay conversation model, tool matrix, authority/identity flow and edge cases.
The current targeted suite passes **158 tests**, including the new context,
adapter, title uniqueness and pagination regressions. Parent reviewed the actual
changes and fixtures as well as the integration results.

The final command E2E passed at
`.tmp/orchestrator-command-smoke/1788630529758-49452/`, including a real saved
Codex fixture resume followed by an omitted-text `Tell it` command resolving to
that newly resumed pane. Because the fake provider exits, the expected outcome
is `not-running` for that pane, with no fallback into the older shell.

The strict foreground-sentinel setup could not take focus from the user's Chrome
window under Windows foreground restrictions. The explicit `--observe-external`
mode then passed the full command flow while a hidden read-only probe watched the
already-foreground external application. Its PID and clipboard sequence stayed
unchanged for 18 samples, with zero violations. That mode makes no external
selected-text claim. Default strict-sentinel assertions remain in the test.
No live provider inference, OpenRouter speech call or physical microphone test was
performed.

Project ordering passed actual Chromium/Electron native drag/drop, keyboard order,
reload persistence, cancellation, 858px long-list edge scrolling, and unchanged
active project and pane/xterm/runtime generation:
`.tmp/project-order-smoke/1788621609242-40084/`. Parent inspected the source and
results. Full dock collapse and continuous reopening passed at
`.tmp/workspace-controls-smoke/1788621700421-34820/`, including collapsed reload
persistence and a 60px pull-open with no minimum-height jump. Parent viewed the
collapsed screenshot and inspected the test assertions.

The current packaged Electron workflow also passed at
`.tmp/orchestrator-smoke/1788630846262-41124/`. Packaged history helper startup/IPC
passed, and hashes confirmed the packaged relay/context/policy/history/integration
files match the reviewed source.


## Progressive access and offline error audio

See [context and audio details](orchestrator-context-and-audio.md). The current
suite passes **207 tests**. Parent review inspected the actual pagination,
context-fitting, error classification, asset loader and voice-controller code,
plus the new regression fixtures and UI merge helper. Corrections included a
sticky billing pause, bookmarks committed only after model delivery, empty/broken
TTS fallback, cancelled deferred alerts, and source-version page deduplication.

Real Electron evidence at `.tmp/audio-context-smoke/1788634805105-33592/` verifies
54,476-character Unicode reconstruction over three earlier page loads, local
search/jump/latest, unchanged source hash, local PCM scheduling/playback ACK,
cooldown and mute. Mic capture was stubbed and WebAudio used zero gain: no claim
of physical speaker quality or live cloud acceptance.

The existing command E2E passed again in strict-sentinel mode at
`.tmp/orchestrator-command-smoke/1788635671910-36960/`, verifying real PTY output,
exact history resume/follow-up, and unchanged foreground/clipboard/selected text
across 18 samples. Its model-history assertion now checks the bounded text
projection; duplicate raw message arrays are intentionally excluded from model
context while direct UI pages retain them. The alternative observe-external run
was rejected at its prerequisite because the fixture itself owned foreground;
that prerequisite failure was not treated as an application regression.

Windows packaging passed and all seven packaged WAV clips passed checksum and
format validation. No new provider credentials were used or stored by tests.
