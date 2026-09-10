# Terminal runtime, progress, and board behavior

Release 0.1.105 adds separate pending-turn display evidence and generation-owned
restart PID tracking. See [the release audit](release-0.1.105-review.md) for input
and result boundaries and acceptance checks.

Standalone panes use a main-process runtime service. The renderer subscribes to retained snapshots, so switching workspaces or rebuilding xterm does not reset conversation discovery, status, or titles. Fusion and Open Fusion retain their chat-host lifecycle transports; all panes share the board geometry repairs.

## Wheel scrolling

Terminal history retains the newest **5,000 scrollback rows**, plus the live
screen, using FIFO eviction. Agent `CSI 3 J` (erase saved lines) redraw commands
are ignored by both display decoders so they cannot wipe all saved history.
Other screen erases still work, alternate-screen applications keep their native
buffers/input, and a terminal reset or a new generation starts fresh.

`backend/terminalHistory.cjs` keeps decoded cells with `@xterm/headless` and
serializes them on attachment. The previous 400,000-character raw-output suffix
could discard all earlier history during spinner/redraw traffic or begin midway
through an escape sequence. Retention is now based on rows, including while a
pane is hidden. Snapshots preserve both buffers, styles, geometry, incomplete
escape/Unicode sequences and the supported TUI input modes. Later output,
resizes and exits stay ordered after each snapshot; command receipts remain
immediate. The extra decoder is bounded by the row limit and disposed on close
or replacement; it has no PTY input connection.

The renderer restores snapshots with an in-stream reset before later live
output, and delays fitting until replay completes. This prevents queued old
output from reappearing after a synchronous reset. Both decoders share
`shared/terminalDisplay.json` for the retention limit.

`node --test scripts/backend/terminal-scrollback.test.cjs` covers sustained
redraws, FIFO overflow, reset protection, split sequences, Unicode, normal and
alternate buffers, reflow, input modes, event ordering and generation disposal.
It also runs in `smoke:backend:terminal-runtime`, a release gate. These repairs
are source changes; existing installed builds and already-discarded output are
not changed by them.

Normal terminal history remains scrollable with the wheel after moving the
scrollbar, including when a TUI has enabled mouse reporting. Shift-wheel selects
local history from the live tail, and exited panes keep their history scrollable.
Running TUIs at the live tail and alternate-screen applications retain their
native mouse or cursor-key scrolling. Upward local scrolling disables following
immediately; reaching the bottom enables it again, so delayed viewport events
cannot leave an obsolete follow-tail flag for the next resize.

`npm run smoke:electron:terminal-scroll` checks these paths with the actual pane
handlers and xterm in isolated offscreen Electron. It includes pixel, line,
page and fractional trackpad deltas, delayed scroll delivery, and preserved
native input. Physical mouse/trackpad hardware is not covered by this fixture.

## Identity and lifecycle

Each pane launch has a backend-issued generation and renderer launch token. PTY events, authenticated callbacks, asynchronous metadata results, and cleanup are checked against that generation. Concurrent creates share preparation; reattachment reuses the live launch. Closing cancels pending preparation, and restart rotates instrumentation. Invalid folders, missing executables, and rejected duplicate conversation ownership produce observable failures.

An App-level launch coordinator starts every explicitly started standalone session,
including inactive projects, Multi sessions and panes hidden by maximization.
Paused sessions remain paused. Visual panes use `terminal.attach` to replay and
resize an existing generation; mounting or navigation cannot launch a process.
Remote creation reports success after the matching backend process is running
and its launcher command has been submitted. Failed, superseded, cancelled and
timed-out starts keep the created pane identity and are never automatically
recreated. Agent input retains its separate observed-readiness checks, and a
staged draft remains unsent. Checked input cannot overtake the launcher command.

For newly created Orchestrator launches, initial Codex, Claude/Claude-custom and
standard PowerShell task input has an additional composer wait. A shell PTY and
an agent wrapper can both be running before the native input field exists. The
wait reads the current decoded screen and cursor visibility; blank screens,
Codex's `model: loading`, disabled input and startup onboarding cannot receive a
task prompt. Unknown lifecycle metadata alone does not block a recognized ready
composer. The original action remains pending for up to 20 seconds, without a
fixed startup sleep or a second submission.

The wait retains the exact launch, generation, recipient, native conversation and
input revision. Cancellation, closure, restart, manual typing and the deadline
end it with no input dispatched. Existing sessions, explicitly authorized draft
edits, busy follow-ups and structured chat hosts keep their existing controls.
Other native provider layouts and customized shell prompts are not certified by
these composer recognizers; unsupported provider kinds retain their previous
semantic operator path. See [startup prompt verification](orchestrator-startup-prompts.md).

Standalone operator input freezes recipient, lifecycle, turn, pending
question/permission, ownership and geometry evidence instead of the general
publication revision. Titles, timestamps and tool-label updates alone do not
invalidate an otherwise current read. Screen/input revisions and final PTY
recipient checks remain mandatory. Runtime snapshots retain `cols` and `rows`,
and a resize rejects stale native control evidence even without new output.
The separately constrained busy-Codex prompt path and chat-host controls retain
their existing rules.

The runtime separates shell lifetime, agent invocation lifetime, foreground turns, and child work. An agent exiting into its shell is not a completed task. Neither Enter nor quiet output establishes agent progress. Native turn IDs reject stale activity/completion; repeated semantic attention events retain their occurrence ID. End timestamps are frozen independently of metadata refresh timestamps.

Submit/interrupt keystrokes are provisional input intent (“awaiting activity” / “interrupt requested”), cleared by provider evidence. They never manufacture a turn start or cancellation. Completion-only Codex configurations can report successive completed turns even when lifecycle observation is disabled or unavailable; no start time is invented for those turns.

Lina grants invocation-scoped trust to its six exact Codex observer commands by
default. Updated observer paths receive matching hashes on the next launch,
without rewriting global Codex configuration. Explicitly disabled hooks remain
disabled, and user/project hooks keep their own trust requirements. See the
[activity and hook trust plan](codex-activity-and-hook-trust-plan.md) for the
implementation and the separate planned pending-input display repair.

Native automated text/paste submissions separate the text from the final Enter
by 200 ms. Codex 0.153.4 on Windows was observed leaving both plain and bracketed
paste unsubmitted when Enter arrived in the same write. The split is one reserved
transport action, not a retry: it holds the input lease and rechecks the terminal,
generation, recipient, input revision, geometry and cancellation before Enter.
Human input during the gap prevents the delayed Enter. Cancellation or failure
after text may have arrived remains an unknown partial write; the app does not
replay the prompt or claim the editor's contents are known. Plain shell and
key-only input keep their existing handling. A `written` receipt still proves
only transport acceptance.

An unknown root ID is confirmed using actual provider metadata before queued lifecycle events are applied. A conservative resume result (`found` on an unreadable store) is not identity proof: confirm results separately carry `rootVerified`. Discovery rejects children, incomplete candidate scans, competing same-folder launches, and conversations already owned by another pane in the same provider home. It retries beyond the previous 90-second deadline, shares lookup reads, and backs off errors.

If an authenticated, unparented verified root conflicts with an already bound
native conversation, the generation becomes ambiguous. The old reference remains
available for history, while current turn/completion proof and automated input
eligibility are retired. Delayed callbacks or metadata cannot establish which
root the TUI selected; restart the pane to obtain a fresh generation. Explicit
child/subagent events retain their separate handling, and manual terminal input
remains available. This detects uncertainty around native `/new`; it does not
implement automatic selected-root migration. See the
[consolidated cohesion review](orchestrator-cohesion-review.md).

## Titles and activity

The [terminal status support matrix](terminal-status-support.md) covers every
integrated pane, its native evidence source, and remaining observation limits.
Run `npm run test:terminal-status` for the combined status regressions.

The pane title prefers a provider conversation name or preview, then the live terminal title, then the pane label. The tooltip includes a differing live terminal title. OSC 0/2 titles are parsed incrementally in the PTY host and retained while a pane is hidden. UTF-8 host framing uses a streaming decoder.

Codex reads the latest saved name from `session_index.jsonl`; its first prompt is a fallback. Claude title reading follows later rename/generated-title records rather than only the transcript head. Kimi, Kimi + CC, Qwen, Cursor, and OpenCode use their metadata adapters. Existing titles continue refreshing.

Click the status chip to inspect current/latest observed tools, child work, elapsed turn time, and observation availability. Exact child counts require identified tasks; anonymous hook brackets produce a generic child-activity indication. Status and sidebar totals use the same runtime projection. Attention is shown only while it matches the current lifecycle; parent completion stays separate from unfinished child work.

Claude's `idle_prompt` is an idle reminder after a response, not evidence of a question ([native hook semantics](https://code.claude.com/docs/en/hooks#notification)). Generated settings omit that notification. The telemetry adapter preserves notification type and ignores known idle reminders; the runtime also rejects the metadata-free question events emitted by older hooks. This applies during startup, provisional responses, active work, and pending submissions, without changing an existing real wait or restarting elapsed time.

Claude uses native `PermissionRequest` for approval attention and `StopFailure` for failed responses. The single wildcard tool observer recognizes `AskUserQuestion` starts as explicit question attention, and tool success/failure resumes the same turn. Unrelated tool callbacks cannot dismiss an open question or consume its pending reply. Resolved or superseded question tool IDs fence delayed duplicate callbacks. Hook metadata carries identities and notification type, without question or answer text. An ordinary final response, including optional follow-up prose, remains “response available”; the monitor does not infer required input from its wording or elapsed silence.

`shared/providerCapabilities.json` defines the retained standalone providers, launch commands, thread support, and adapter capabilities. These capabilities describe the adapter, not proof that a particular installed CLI has emitted usable telemetry. Missing native fields remain coarse. Aider is removed; saved Aider panes migrate to paused plain terminals, preserving folders, names, and tile membership without running the old command.

## Gemini and passive hooks

Gemini uses a temporary per-invocation system-defaults overlay. Existing defaults/hooks, user/workspace configuration, authentication, and disabled-hook settings are preserved. Its adapter observes session lifecycle, tools, approval notifications, and responses; backend metadata validates the root. Both legacy JSON and JSONL metadata updates are supported. Resume uses a full session UUID.

Gemini's `AfterAgent` observation is provisional because another hook may request a retry afterward. It produces “response available,” not verified task completion. Hook-only completion channels (including Claude Stop) also remain provisional: the runtime requires authoritative completion capability plus root-thread and native turn identity before reporting “done.” Missing identities never become proof when a timer expires or child activity ends.

Shared passive Node/PowerShell hook readers retain available session, turn, tool, and task metadata. They do not make permission decisions. Invocation UUIDs pair process start and exit and distinguish nested shims. OpenCode installs into the resolved configuration home, including a fresh home. Kimi variants share a stock-compatible hook installation without duplicate or fork-only entries in the stock configuration.

## Placement and sizing

New panes, duplicates, add-matching, and popped-out panes use the shared empty-region search. It fills visible holes first, then existing offscreen holes, before extending the board. Only actual tile anchors occupy space. New panes select themselves and reveal their location with minimal board scrolling.

Default solo minimum: **280×170 CSS pixels**. Automatic growth limit: **560×320**. New panes target a half-board column capped at 560px, with a 260px starting height. Manual resizing may exceed this limit; split subtree minimums override it.

Dragging previews the exact committed fit. Ordinary dragging prefers empty space; **hold Shift to swap** with another tile. Snapping acquires within 12px and releases beyond 18px. Impossible drops retain the last valid preview. Resize affects adjacent neighbors within minimum constraints and does not globally compact unaffected panes. Geometry accounts for scroll offsets and the viewport's client dimensions, excluding scrollbar width.

After arrangement settles, xterm measures the final bounds and sends generation-scoped PTY dimensions. Hidden or zero-size bounds do not advertise default dimensions. Tail-following and intentionally viewed scrollback remain separate.

## Codex cursor

Codex panes use a steady bar cursor, including while unfocused. `frontend/terminalCursor.ts` handles Codex's default-user-shape reset (`CSI 0 SP q`, or omitted parameter) because xterm 5.5 otherwise turns it into a blinking block. The DOM renderer restarts that block's animation on row replacement, causing orange cursor flashes during redraws. Explicit application cursor styles still pass through. The handler survives snapshot resets and is disposed with the pane; other providers keep their existing defaults.

`node scripts/qa/terminal-cursor-smoke.cjs` checks the real Electron/xterm DOM renderer in an isolated offscreen window with simulated focus. It verifies default resets, typing/output redraws, inactive rendering, snapshot reset, explicit styles, and disposal; it does not launch a live Codex turn.

## Bridge, persistence, and verification

`terminal.getRuntimeSnapshots()` returns retained snapshots; `terminal.onRuntime(callback)` subscribes to full snapshot updates. Subscribe before requesting snapshots and compare generation/revision before applying them. The screen byte stream remains on `terminal.onEvent`. Input/resize/kill accept generation/launch-token scope. Snapshot fields include process/turn state, conversation and terminal title, observation health, active/last tools, child activity, attention identity, and elapsed timestamps.

Live runtime snapshots are not persisted into workspace configuration. Conversation references/names are saved so reopening the app, including a restart after an update, resumes each agent pane left started at exit using its exact current conversation ID. Paused panes stay paused; closing a pane removes it from restoration. Manual New/Restart actions retain their existing behavior. An unknown current ID starts fresh, without guessing from another pane or an older `resumeRef`.

The launch coordinator confirms saved standalone IDs before creating the process. An explicitly missing conversation falls back to a fresh launch with a notice (Claude keeps its preassigned UUID; other providers clear the obsolete ID). An unavailable or inconclusive lookup still attempts the exact saved ID. Cancellation during confirmation prevents a late launch. Fusion and Open Fusion use their existing resume/transcript rehydration paths; App-level host events retain chat identity even while the pane is unmounted.

`node scripts/qa/session-resume-smoke.cjs` checks a real hidden Electron close/reopen with isolated app data and fixture start/confirmation IPC. It covers every threaded provider, both Fusion planner families, Open Fusion, distinct chats sharing a folder, and paused panes. It checks resume commands and chat IDs without launching paid provider turns or certifying every installed CLI version. Run `npm run build` first. Focused regressions also include `node --test scripts/frontend/chat-session-persistence.test.cjs`.

Focused commands:

- `npm run smoke:backend:terminal-runtime`
- `npm run smoke:backend:agent-generation`
- `npm run smoke:backend:metadata`
- `npm run smoke:frontend:terminal-runtime`
- `npm run smoke:frontend:app-runtime`
- `npm run smoke:frontend:session-persistence`
- `npm run test:frontend:terminal-launch`
- `npm run smoke:electron:orchestrator-background-launch`
- `npm run smoke:frontend:tiled-resize`
- `npm run build` followed by `npm run smoke:electron:terminal-board`

The Electron check uses isolated app data and real PTYs to verify hole placement, drag/drop previews, explicit swapping, final xterm/PTY dimensions, hidden title retention, scroll-aware dragging, and horizontal overflow. Its diagnostics and screenshots are written under `.tmp/terminal-board-smoke/`. Provider fixtures exercise native hook transports and metadata without running paid agent turns; they do not certify every installed provider version.
