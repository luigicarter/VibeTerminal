# Scripts

The `scripts/` folder is split by purpose so app launch, backend validation, and visual QA do not sit in one flat bucket.

## App Scripts

- `scripts/app/dev.cjs` - Starts the Vite frontend, waits for `http://127.0.0.1:5173`, then launches Electron pointed at that dev server. Also cleans up the renderer process when Electron exits.

## Backend Scripts

- `scripts/backend/codex-discovery-smoke.cjs` - Creates temporary fake Codex session metadata and validates `backend/agentThreads.cjs` behavior for pending, found, excluded, different-cwd, ambiguous, and remaining-candidate cases.
- `scripts/backend/agent-telemetry-smoke.cjs` - Creates temporary fake provider commands, validates per-pane shim PATH injection, telemetry token rejection, lifecycle attention events, and stale owned shim cleanup.

## Frontend Scripts

- `scripts/frontend/attention-smoke.cjs` - Validates the shared terminal attention helpers used to decide whether sidebar workspace dots should appear and when unread attention is cleared.

## QA Scripts

- `scripts/qa/screenshot.cjs` - Starts the Vite frontend and Electron in screenshot mode, captures the visible app window, verifies the PNG exists, and writes `artifacts/vibe-terminal-screenshot.png`.

## npm Commands

- `npm run dev` - Full app development launcher.
- `npm run dev:frontend` - Vite frontend only.
- `npm run dev:renderer` - Compatibility alias for `dev:frontend`.
- `npm run typecheck` - TypeScript check with no emit.
- `npm run build` - TypeScript check plus Vite production build.
- `npm run screenshot` - Visual QA screenshot pass.
- `npm run smoke:backend:codex-discovery` - Backend smoke test for Codex thread discovery.
- `npm run smoke:backend:agent-telemetry` - Backend smoke test for vibeTerminal-owned agent telemetry shims.
- `npm run smoke:frontend:attention` - Frontend smoke test for terminal attention helper behavior.
- `npm run smoke:codex-discovery` - Compatibility alias for the backend smoke test.
