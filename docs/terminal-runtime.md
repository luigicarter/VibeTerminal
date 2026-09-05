# Terminal runtime, progress, and board behavior

Standalone panes use a main-process runtime service. The renderer subscribes to retained snapshots, so switching workspaces or rebuilding xterm does not reset conversation discovery, status, or titles. Fusion and Open Fusion retain their chat-host lifecycle transports; all panes share the board geometry repairs.

## Identity and lifecycle

Each pane launch has a backend-issued generation and renderer launch token. PTY events, authenticated callbacks, asynchronous metadata results, and cleanup are checked against that generation. Concurrent creates share preparation; reattachment reuses the live launch. Closing cancels pending preparation, and restart rotates instrumentation. Invalid folders, missing executables, and rejected duplicate conversation ownership produce observable failures.

The runtime separates shell lifetime, agent invocation lifetime, foreground turns, and child work. An agent exiting into its shell is not a completed task. Neither Enter nor quiet output establishes agent progress. Native turn IDs reject stale activity/completion; repeated semantic attention events retain their occurrence ID. End timestamps are frozen independently of metadata refresh timestamps.

Submit/interrupt keystrokes are provisional input intent (“awaiting activity” / “interrupt requested”), cleared by provider evidence. They never manufacture a turn start or cancellation. Completion-only Codex configurations can report successive completed turns even when the optional lifecycle observer has not been trusted; no start time is invented for those turns.

An unknown root ID is confirmed using actual provider metadata before queued lifecycle events are applied. A conservative resume result (`found` on an unreadable store) is not identity proof: confirm results separately carry `rootVerified`. Discovery rejects children, incomplete candidate scans, competing same-folder launches, and conversations already owned by another pane in the same provider home. It retries beyond the previous 90-second deadline, shares lookup reads, and backs off errors.

## Titles and activity

The pane title prefers a provider conversation name or preview, then the live terminal title, then the pane label. The tooltip includes a differing live terminal title. OSC 0/2 titles are parsed incrementally in the PTY host and retained while a pane is hidden. UTF-8 host framing uses a streaming decoder.

Codex reads the latest saved name from `session_index.jsonl`; its first prompt is a fallback. Claude title reading follows later rename/generated-title records rather than only the transcript head. Kimi, Kimi + CC, Qwen, Cursor, and OpenCode use their metadata adapters. Existing titles continue refreshing.

Click the status chip to inspect current/latest observed tools, child work, elapsed turn time, and observation availability. Exact child counts require identified tasks; anonymous hook brackets produce a generic child-activity indication. Status and sidebar totals use the same runtime projection. Attention is shown only while it matches the current lifecycle; parent completion stays separate from unfinished child work.

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

## Bridge, persistence, and verification

`terminal.getRuntimeSnapshots()` returns retained snapshots; `terminal.onRuntime(callback)` subscribes to full snapshot updates. Subscribe before requesting snapshots and compare generation/revision before applying them. The screen byte stream remains on `terminal.onEvent`. Input/resize/kill accept generation/launch-token scope. Snapshot fields include process/turn state, conversation and terminal title, observation health, active/last tools, child activity, attention identity, and elapsed timestamps.

Live runtime snapshots are not persisted into workspace configuration. Confirmed conversation references/names are persisted for deliberate resume. Reopening the app retains the existing fresh-conversation behavior; layout restoration does not automatically resume the previous chat.

Focused commands:

- `npm run smoke:backend:terminal-runtime`
- `npm run smoke:backend:agent-generation`
- `npm run smoke:backend:metadata`
- `npm run smoke:frontend:terminal-runtime`
- `npm run smoke:frontend:app-runtime`
- `npm run smoke:frontend:session-persistence`
- `npm run smoke:frontend:tiled-resize`
- `npm run build` followed by `npm run smoke:electron:terminal-board`

The Electron check uses isolated app data and real PTYs to verify hole placement, drag/drop previews, explicit swapping, final xterm/PTY dimensions, hidden title retention, scroll-aware dragging, and horizontal overflow. Its diagnostics and screenshots are written under `.tmp/terminal-board-smoke/`. Provider fixtures exercise native hook transports and metadata without running paid agent turns; they do not certify every installed provider version.
