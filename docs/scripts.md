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

## Frontend Scripts

- `scripts/frontend/attention-smoke.cjs` - Validates the shared terminal attention helpers used to decide whether sidebar workspace dots should appear and when unread attention is cleared.
- `scripts/frontend/workspace-smoke.cjs` - Validates empty-install workspace startup, project folder removal wiring, and sidebar remove control styling.
- `scripts/frontend/session-launch-smoke.cjs` - Validates launch/resume command construction and launch-mode gating, and guards that the terminal-creation effect stays decoupled from the command string so a resume id discovered mid-session cannot blank a live pane.

## QA Scripts

- `scripts/qa/screenshot.cjs` - Starts the Vite frontend and Electron in screenshot mode, captures the visible app window, verifies the PNG exists, and writes `artifacts/vibe-terminal-screenshot.png`.

## npm Commands

- `npm run dev` - Full app development launcher.
- `npm run dev:frontend` - Vite frontend only.
- `npm run dev:renderer` - Compatibility alias for `dev:frontend`.
- `npm run typecheck` - TypeScript check with no emit.
- `npm run build` - TypeScript check plus Vite production build.
- `npm run pack:win` - Builds the renderer and creates an unpacked Windows app in `release/win-unpacked`.
- `npm run dist:win` - Builds the renderer and creates the Windows NSIS installer plus update metadata in `release/`.
- `npm run screenshot` - Visual QA screenshot pass.
- `npm run smoke:backend:codex-discovery` - Backend smoke test for Codex thread discovery.
- `npm run smoke:backend:claude-discovery` - Backend smoke test for Claude thread discovery.
- `npm run smoke:backend:agent-telemetry` - Backend smoke test for vibeTerminal-owned agent telemetry shims.
- `npm run smoke:backend:code-changes` - Backend smoke test for code-change tracking.
- `npm run smoke:backend:updates` - Backend smoke test for update policy and silent Windows update apply behavior.
- `npm run smoke:frontend:attention` - Frontend smoke test for terminal attention helper behavior.
- `npm run smoke:frontend:workspace` - Frontend smoke test for workspace startup and project folder removal behavior.
- `npm run smoke:frontend:session-launch` - Frontend smoke test for launch/resume command building and terminal-pane launch decoupling.
- `npm run smoke:codex-discovery` - Compatibility alias for the backend smoke test.
