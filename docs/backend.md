# Backend

The `backend/` folder contains Electron main-process code and Node-side terminal/session helpers.

## Files

- `backend/main.cjs` - Electron app entry point from `package.json`; creates the BrowserWindow, starts child hosts, owns IPC handlers, handles folder selection, and brokers latest-agent-thread lookups.
- `backend/ptyHost.cjs` - Child process that owns `node-pty` terminal sessions, buffers scrollback, forwards terminal data, resizes sessions, kills sessions, and emits JSONL events to the main process.
- `backend/agentTelemetry.cjs` - Creates vibeTerminal-owned per-pane agent shims, starts the local telemetry callback server, maps agent lifecycle events to pane attention events, and removes stale owned shim directories.
- `backend/agentThreadHost.cjs` - Child process that performs Codex, Claude, and OpenCode thread metadata discovery so filesystem scans and CLI lookups do not block Electron main or terminal IPC.
- `backend/agentThreads.cjs` - Codex thread discovery utilities used by the discovery host and smoke tests; reads local Codex session metadata and returns pending, found, ambiguous, or failed lookup results.

## Runtime Flow

- `backend/main.cjs` starts `backend/ptyHost.cjs` with Node.
- `backend/main.cjs` starts `backend/agentThreadHost.cjs` with Node for agent-thread discovery requests.
- `backend/main.cjs` starts the local agent telemetry manager and enriches each terminal launch with vibeTerminal-only shim environment variables.
- The renderer talks to `backend/main.cjs` through the preload bridge.
- `backend/main.cjs` forwards terminal commands to the PTY host over stdin and broadcasts PTY events back to all renderer windows.
- Production Electron loads `dist/index.html`; development Electron loads the Vite URL from `VITE_DEV_SERVER_URL`.
