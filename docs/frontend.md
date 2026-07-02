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
- `frontend/components/FusionChatPane.tsx` - The Fusion (Claude + Codex) chat pane: renders the normalized `fusion-chat:event` stream as a role-voiced transcript with decision panels, plan-accept bar, and a local slash palette.
- `frontend/components/OpenFusionChatPane.tsx` - The Open Fusion chat pane over `window.vibe.openFusionChat` (headless per-pane `opencode serve`; the OpenCode TUI is not rendered). Brands the pane with its own hero/empty state, voices Brain/Executor/Scout roles distinctly, renders `task` delegations as visible cards (other tool traffic folds into the Details lane), answers OpenCode permission asks in-pane (Allow / Allow session / Reject), and hosts `/brain-model` + `/executor-model` pickers fed by the server's provider catalog — Brain picks apply live, Executor picks restart the pane via `onSettingsChange`. Provider auth is in-pane with full OpenCode parity: "needs auth" picker entries and `/connect <id>` walk the provider's real auth methods from `GET /provider/auth` — method choice when there are several, prompt fields (text/select), masked API-key entry whose prompt answers become credential `metadata`, or browser OAuth (authorize → open/copy URL → paste code or auto device-flow wait). `/disconnect <id>` removes a credential. Everything lands in OpenCode's own credential store, never vibeTerminal's.
- `frontend/components/TiledBoard.tsx` - Drag/resize layout engine for terminal panes, including collision handling, swaps, adjacent resize behavior, and persisted fluid layouts.

## Working / done signals

Two sidebar signals share the dot slot on each folder button and the Multi-mode card (`App.tsx`), with the blue attention dot taking priority over the working spinner:

- **Blue attention dot** (`shouldShowAttentionDot`) - a pane finished a turn / needs you (`attention.unread` + `waiting|completed|failed`). Cleared by selecting the pane.
- **Amber working spinner** (`.attention-dot-working`, gated by `isSessionWorking` = `status === "running"`) - a pane is actively running a turn.

"Working" must mean the agent is working, not the user interacting, so `status === "running"` is set by exactly one source per pane kind — never by raw output that could be a keystroke echo or a focus/click redraw:

- **claude / opencode / cursor** (`isTurnTelemetryKind`) - driven purely by turn telemetry: the `agent-running` event with `turnStart:true` (a genuine turn start) forces `running` via `applyAgentRunning` even past the done/failed latch; `turnStart:false` (claude tool activity) goes through `reconcileStatus`, so a tool hook whose POST races past the turn's `Stop` cannot resurrect a finished pane. `agent-attention` settles status to `waiting`/`done`. `TerminalPane` never marks these working from output, and `applyTerminalStatus` ignores a `running` derived from their terminal events. (cursor's turn start is its `beforeSubmitPrompt` hook; it emits no `waiting`, so `running` simply holds until `stop`.)
- **codex / plain terminals / others** - the `TerminalPane` output heuristic (`markActiveFromOutput`): output reads as "working" unless it lands within `INPUT_GRACE_MS` of the user's last keystroke/click (echo/redraw suppression). The App-level listener no longer derives `running` from `data`, so background non-agent panes show no spinner (no mounted heuristic) — by design. When a mounted pane unmounts while still marked `running` by the heuristic, cleanup settles it back to `waiting` before discarding the mounted idle timer, which prevents folder spinners from getting stuck on "working" after switching workspaces or maximizing another pane. The same cleanup also settles a stale `starting` pill to `waiting` if the pane unmounts during initial boot.

The done/failed pill is a latch (`reconcileStatus`): trailing output — the shell prompt returning after an agent exits, a stray byte — must never flip a finished pane back to working/waiting. What releases or settles a stuck pill is **keyboard input** into the pane (`statusAfterUserInput` in `attention.ts`, applied through the pane's `onInputStatusRelease` callback which bypasses `reconcileStatus`):

- **codex / plain terminals** - typing is their equivalent of claude's `UserPromptSubmit` (codex has no turn-start telemetry, so without this a codex pane latched `done` by its turn-end notify could never show working/waiting again until restart). The latch releases to `waiting`; real output then flips it to `running` via the heuristic.
- **claude (approval waits only)** - answering a permission prompt has no hook of its own (`PreToolUse` fires before the prompt, `PostToolUse` only when the tool ends), so the answer keystroke flips `waiting`->`running` immediately instead of reading "requires feedback" for the whole tool run. Idle/question waits stay put — composing a prompt is not working.
- **telemetry kinds, bare Esc while `running`** - the TUI interrupt key. No hook fires for an interrupt (claude's `Stop` does not), so Esc settles the pill to `waiting` immediately; if it merely dismissed a menu, the next telemetry event re-asserts `running` (waiting->running is never latched).
- `isHumanTerminalInput` filters out terminal-generated reports (focus in/out, mouse reports, arrow keys — anything starting with a bare ESC except a bracketed paste), so clicking or focusing a finished TUI pane never disturbs its pill.

Two more guards keep pills truthful across missed hooks and remounts:

- **Stale-running watchdog** (`TELEMETRY_RUNNING_QUIET_MS`, `armTelemetrySettle` in `TerminalPane`): a telemetry-kind pane that stays `running` with zero PTY output for ~12s settles to `waiting` — these TUIs repaint their spinner constantly while genuinely working, so prolonged total silence means the turn ended without its hook (interrupt, lost POST). The settle fires only if the status is unchanged since arming, so a `starting`->`running` transition never settles a fresh turn on the shorter boot delay.
- **Remounts are replays**: a `snapshot` is buffered old output (workspace switch, maximize), so it never marks a pane working (`statusFromTerminalEvent` returns null for a running snapshot; the pane only re-arms the telemetry settle from it), and the launch effect only sets `starting` when the status is `idle` — every genuine launch path (create/restart/resume/settings change) resets to `idle` first, so a remount of a live pane never disturbs a settled `done`/`failed`/`waiting` pill.

## Entry Points

- `index.html` loads `/frontend/main.tsx`.
- `tsconfig.json` includes `frontend/` for strict renderer typechecking.
- `npm run dev:frontend` starts the Vite renderer on `127.0.0.1:5173`.
