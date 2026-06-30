# Frontend

The `frontend/` folder contains the Vite React renderer that users see inside the Electron window.

## Files

- `frontend/main.tsx` - React entry point mounted by `index.html`.
- `frontend/App.tsx` - Top-level workspace UI, localStorage persistence, project selection, code-change line totals, session lifecycle, and agent launcher controls. On app reopen, `restoreSession` brings every pane back as a **fresh** terminal (never an auto-resumed chat): a threaded pane's prior thread is moved into `resumeRef` and a new chat is launched, so "restore my workspace" is decoupled from "resume my conversation". `resumeSession` is the explicit opt-in that relaunches the stashed `resumeRef` thread.
- `frontend/sessionLaunch.ts` - Builds launch/resume commands for Codex, Claude, OpenCode, Cursor, and plain terminal sessions.
- `frontend/types.ts` - Shared renderer-side domain types for agents, sessions, layouts, thread lookup results, and terminal events.
- `frontend/electron.d.ts` - Type declarations for the `window.vibe` preload API used by the renderer.
- `frontend/vite-env.d.ts` - Vite environment declarations.
- `frontend/styles.css` - App shell, sidebar, toolbar, terminal pane, status, and tiled-board styling.

## Components

- `frontend/components/TerminalPane.tsx` - Owns the xterm instance for a session (pinned to the session id so it survives launch-command changes), sends terminal input/resize IPC calls, receives PTY events, relaunches the PTY only on a launchToken bump, and polls for agent thread metadata. Renders a "Resume last chat" control (wired to `onResume`) only when the pane has a `resumeRef`.
- `frontend/components/TiledBoard.tsx` - Drag/resize layout engine for terminal panes, including collision handling, swaps, adjacent resize behavior, and persisted fluid layouts.

## Working / done signals

Two sidebar signals share the dot slot on each folder button and the Multi-mode card (`App.tsx`), with the blue attention dot taking priority over the working spinner:

- **Blue attention dot** (`shouldShowAttentionDot`) - a pane finished a turn / needs you (`attention.unread` + `waiting|completed|failed`). Cleared by selecting the pane.
- **Amber working spinner** (`.attention-dot-working`, gated by `isSessionWorking` = `status === "running"`) - a pane is actively running a turn.

"Working" must mean the agent is working, not the user interacting, so `status === "running"` is set by exactly one source per pane kind — never by raw output that could be a keystroke echo or a focus/click redraw:

- **claude / opencode / cursor** (`isTurnTelemetryKind`) - driven purely by turn telemetry: the `agent-running` event (turn start) forces `running` via `applyAgentRunning`; `agent-attention` settles it to `waiting`/`done`. `TerminalPane` never marks these working from output, and `applyTerminalStatus` ignores a `running` derived from their terminal events. (cursor's turn start is its `beforeSubmitPrompt` hook; it emits no `waiting`, so `running` simply holds until `stop`.)
- **codex / plain terminals / others** - the `TerminalPane` output heuristic (`markActiveFromOutput`): output reads as "working" unless it lands within `INPUT_GRACE_MS` of the user's last keystroke/click (echo/redraw suppression). The App-level listener no longer derives `running` from `data`, so background non-agent panes show no spinner (no mounted heuristic) — by design. When a mounted pane unmounts while still marked `running` by the heuristic, cleanup settles it back to `waiting` before discarding the mounted idle timer, which prevents folder spinners from getting stuck on "working" after switching workspaces or maximizing another pane. The same cleanup also settles a stale `starting` pill to `waiting` if the pane unmounts during initial boot.

## Entry Points

- `index.html` loads `/frontend/main.tsx`.
- `tsconfig.json` includes `frontend/` for strict renderer typechecking.
- `npm run dev:frontend` starts the Vite renderer on `127.0.0.1:5173`.
