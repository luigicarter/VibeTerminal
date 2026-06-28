# Backend

The `backend/` folder contains Electron main-process code and Node-side terminal/session helpers.

## Files

- `backend/main.cjs` - Electron app entry point from `package.json`; creates the BrowserWindow, starts child hosts, owns IPC handlers, handles folder selection, and brokers latest-agent-thread lookups.
- `backend/codeChanges.cjs` - Runs and parses read-only Git status and diff checks for workspace code-change tracking.
- `backend/ptyHost.cjs` - Child process that owns `node-pty` terminal sessions, buffers scrollback, forwards terminal data, resizes sessions, kills sessions, and emits JSONL events to the main process.
- `backend/agentTelemetry.cjs` - Creates vibeTerminal-owned per-pane agent shims, starts the local telemetry callback server, installs per-turn notification hooks for the threaded agents, maps agent lifecycle events to pane attention events, and removes stale owned shim directories.
- `backend/agentThreadHost.cjs` - Child process that performs Codex, Claude, and OpenCode thread metadata discovery so filesystem scans and CLI lookups do not block Electron main or terminal IPC.
- `backend/agentThreads.cjs` - Codex thread discovery utilities used by the discovery host and smoke tests; reads local Codex session metadata and returns pending, found, ambiguous, or failed lookup results.

## Runtime Flow

- `backend/main.cjs` starts `backend/ptyHost.cjs` with Node.
- `backend/main.cjs` starts `backend/agentThreadHost.cjs` with Node for agent-thread discovery requests.
- `backend/main.cjs` starts the local agent telemetry manager and enriches each terminal launch with vibeTerminal-only shim environment variables.
- The renderer talks to `backend/main.cjs` through the preload bridge.
- `backend/main.cjs` forwards terminal commands to the PTY host over stdin and broadcasts PTY events back to all renderer windows.
- Production Electron loads `dist/index.html`; development Electron loads the Vite URL from `VITE_DEV_SERVER_URL`.

## Agent notifications (folder attention dot)

The left-sidebar attention dot is driven by `agent-attention` events the telemetry callback server
(`backend/agentTelemetry.cjs`) emits and the renderer maps onto `session.attention`. Per-turn signals
come from each agent's native hook/notify mechanism, which POSTs `{type, sessionId}` to the callback
URL the shim injects (`VIBE_TERMINAL_CALLBACK_URL` / `_TELEMETRY_TOKEN` / `_SESSION_ID`). Each hook
reports `sessionId = VIBE_TERMINAL_SESSION_ID` (the pane id), not the agent's own id.

- **claude** - launched with `--settings <runDir>/claude-settings.json` (injected by the shim). `Stop`
  fires `agent.completed`; `Notification` (`permission_prompt|idle_prompt`) fires `agent.waiting`.
- **codex** - launched with `-c notify=[...]` (injected by the shim) pointing at the per-run notify
  program. codex only emits turn-complete, so it maps to `agent.completed`.
- **opencode** - a guarded global plugin in the user's opencode config dir (installed idempotently;
  no-ops unless the `VIBE_TERMINAL_*` env vars are set). Maps `session.idle`->`agent.completed`,
  `permission.asked`->`agent.waiting`, `session.error`->`agent.failed`.

The notify program is `notify.ps1` on Windows and a Node `notify-hook.cjs` via `notify.sh` on POSIX,
written per run next to `shim-runner.cjs`. The shim still posts `agent.process.exited` as a
crash/quit fallback. Covered by `npm run smoke:backend:agent-telemetry`.
