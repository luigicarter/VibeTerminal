# Scripts

The `scripts/` folder is split by purpose so app launch, backend validation, and visual QA do not sit in one flat bucket.

## App Scripts

- `scripts/app/dev.cjs` - Starts the Vite frontend, waits for `http://127.0.0.1:5173`, then launches Electron pointed at that dev server. Also cleans up the renderer process when Electron exits.

## Backend Scripts

- `scripts/backend/codex-discovery-smoke.cjs` - Creates temporary fake Codex session metadata and validates `backend/agentThreads.cjs` behavior for pending, found, excluded, different-cwd, ambiguous, and remaining-candidate cases.
- `scripts/backend/claude-discovery-smoke.cjs` - Creates temporary fake Claude transcripts and validates `backend/agentThreadHost.cjs` Claude discovery for title extraction from array content, `excludeIds` filtering, foreign-cwd tolerance, and the `after` cutoff.
- `scripts/backend/agent-telemetry-smoke.cjs` - Creates temporary fake provider commands, validates per-pane shim PATH injection, telemetry token rejection, lifecycle attention events, and stale owned shim cleanup.
- `scripts/backend/code-changes-smoke.cjs` - Validates Git status parsing and non-repository workspace handling for code-change tracking.
- `scripts/backend/update-smoke.cjs` - Validates packaged update policy, silent Windows update apply behavior, and matching user-facing docs.
- `scripts/backend/fusion-launch-smoke.cjs` - Validates Fusion per-pane prompt/MCP file generation and confirms the adapter receives the embedded Codex binary path.
- `scripts/backend/fusion-adapter-smoke.cjs` - Validates the Fusion adapter MCP surface exposed to Claude.
- `scripts/backend/fusion-chat-parse-smoke.cjs` - Validates headless Claude stream-json normalization used by the Fusion chat host.
- `scripts/backend/fusion-appserver-smoke.cjs` - Boots Codex `app-server` over stdio and validates the initialize handshake; `--require-embedded` requires `vendor/codex-bin` and is used by release checks.

## Frontend Scripts

- `scripts/frontend/attention-smoke.cjs` - Validates the shared terminal attention helpers used to decide whether sidebar workspace dots should appear and when unread attention is cleared.
- `scripts/frontend/workspace-smoke.cjs` - Validates empty-install workspace startup, project folder removal wiring, and sidebar remove control styling.
- `scripts/frontend/session-launch-smoke.cjs` - Validates launch/resume command construction and launch-mode gating, and guards that the terminal-creation effect stays decoupled from the command string so a resume id discovered mid-session cannot blank a live pane.
- `scripts/frontend/tiled-board-resize-smoke.cjs` - Validates tiled-board resize geometry so adjacent panes stop at blocking panes instead of sweeping over them and burying untouched panes on release.

## QA Scripts

- `scripts/qa/screenshot.cjs` - Starts the Vite frontend and Electron in screenshot mode, captures the visible app window, verifies the PNG exists, and writes `artifacts/vibe-terminal-screenshot.png`.

## npm Commands

- `npm run dev` - Full app development launcher.
- `npm run dev:frontend` - Vite frontend only.
- `npm run dev:renderer` - Compatibility alias for `dev:frontend`.
- `npm run typecheck` - TypeScript check with no emit.
- `npm run build` - TypeScript check plus Vite production build.
- `npm run prepare:codex-bin` - Optionally copies the global `@openai/codex` native binary into `vendor/codex-bin/<platform>-<arch>` for Fusion packaging.
- `npm run prepare:codex-bin:required` - Required release variant; exits nonzero if the pinned native Codex binary is missing or version-incompatible.
- `npm run pack:win` - Prepares the embedded Codex binary, builds the renderer, and creates an unpacked Windows app in `release/win-unpacked`.
- `npm run dist:win` - Prepares the embedded Codex binary, builds the renderer, and creates the Windows NSIS installer plus update metadata in `release/`.
- `npm run screenshot` - Visual QA screenshot pass.
- `npm run smoke:backend:codex-discovery` - Backend smoke test for Codex thread discovery.
- `npm run smoke:backend:claude-discovery` - Backend smoke test for Claude thread discovery.
- `npm run smoke:backend:agent-telemetry` - Backend smoke test for vibeTerminal-owned agent telemetry shims.
- `npm run smoke:backend:code-changes` - Backend smoke test for code-change tracking.
- `npm run smoke:backend:updates` - Backend smoke test for update policy and silent Windows update apply behavior.
- `npm run smoke:backend:fusion-launch` - Backend smoke test for Fusion prompt/MCP launch files.
- `npm run smoke:backend:fusion-adapter` - Backend smoke test for the Fusion adapter MCP tools.
- `npm run smoke:backend:fusion-chat-parse` - Backend smoke test for Fusion headless Claude stream parsing.
- `npm run smoke:backend:fusion-appserver` - Backend smoke test for Codex app-server initialize over stdio, with optional PATH fallback.
- `npm run smoke:backend:fusion-appserver:embedded` - Backend smoke test requiring the embedded Codex binary.
- `npm run smoke:frontend:attention` - Frontend smoke test for terminal attention helper behavior.
- `npm run smoke:frontend:workspace` - Frontend smoke test for workspace startup and project folder removal behavior.
- `npm run smoke:frontend:session-launch` - Frontend smoke test for launch/resume command building and terminal-pane launch decoupling.
- `npm run smoke:frontend:tiled-resize` - Frontend smoke test for tiled-board resize geometry and no-overlap release behavior.
- `npm run smoke:codex-discovery` - Compatibility alias for the backend smoke test.
