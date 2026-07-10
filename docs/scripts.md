# Scripts

The `scripts/` folder is split by purpose so app launch, backend validation, and visual QA do not sit in one flat bucket.

## App Scripts

- `scripts/app/dev.cjs` - Starts the Vite frontend, waits for `http://127.0.0.1:5173`, then launches Electron pointed at that dev server. Also cleans up the renderer process when Electron exits.

## Backend Scripts

- `scripts/backend/codex-discovery-smoke.cjs` - Creates temporary fake Codex session metadata and validates `backend/agentThreads.cjs` behavior for pending, found, excluded, different-cwd, ambiguous, and remaining-candidate cases.
- `scripts/backend/claude-discovery-smoke.cjs` - Creates temporary fake Claude transcripts and validates `backend/agentThreadHost.cjs` Claude discovery for title extraction from array content, `excludeIds` filtering, foreign-cwd tolerance, and the `after` cutoff.
- `scripts/backend/agent-telemetry-smoke.cjs` - Creates temporary fake provider commands, validates per-pane shim PATH injection, telemetry token rejection, lifecycle attention events, and stale owned shim cleanup.
- `scripts/backend/code-changes-smoke.cjs` - Validates Git status parsing and non-repository workspace handling for code-change tracking.
- `scripts/backend/launch-cwd-smoke.cjs` - Validates terminal/Fusion launch cwd resolution rejects missing or file paths without creating them.
- `scripts/backend/update-smoke.cjs` - Validates packaged update policy, silent Windows update apply behavior, and matching user-facing docs.
- `scripts/backend/fusion-launch-smoke.cjs` - Validates Fusion per-pane prompt/MCP file generation and confirms the adapter receives the embedded Codex binary path.
- `scripts/backend/fusion-adapter-smoke.cjs` - Validates the Fusion adapter MCP surface exposed to Claude.
- `scripts/backend/fusion-chat-parse-smoke.cjs` - Validates headless Claude stream-json normalization used by the Fusion chat host.
- `scripts/backend/completion-gate-smoke.cjs` - Validates the completion-gate tracker (backend/completionGate.cjs): executor-return latch, per-mode evidence matching (git bash / read-changed-file / investigator / codex_investigate / native shell), gate verdicts on clean settles, and the one-shot corrective nudge.
- `scripts/backend/openfusion-chat-parse-smoke.cjs` - Validates OpenCode `/event` SSE normalization used by the Open Fusion chat host (delta/snapshot dedupe, task child-session roles, permission round-trip, abort suppression, resume rehydration, model-id splitting, serve spawn env), against event shapes recorded live from OpenCode 1.17.11.
- `scripts/backend/openfusion-background-status-smoke.cjs` - Validates the pane-bound, host-written Open Fusion background snapshot plus the `background_status` MCP list/detail/not-found behavior and real stdio tool call.
- `scripts/backend/openfusion-isolation-smoke.cjs` - Locks Open Fusion data ownership: app-owned OpenCode home layout + XDG env in the pane spawn, one-time threads-only migration from the global store (credentials never copied, global store never written), model-less generated configs (no default models), discovery-spawn env overrides, and the pane/host first-run gate + unknown-provider refusal source contracts.
- `scripts/backend/openfusion-custom-provider-smoke.cjs` - Locks the add-your-own OpenAI-compatible provider slice: the PATCH `/global/config` body shape (npm pin, base URL, user-named models, optional context window with the derived output cap that keeps opencode's compaction threshold sane for sub-32k models), the app-owned config removal rewrite (`.json` + `.jsonc`), the global-config filename seeding, the renderer's name→id and context-shorthand parsing, and the pane/preload/main/host wiring contracts.
- `scripts/backend/fusion-appserver-smoke.cjs` - Boots Codex `app-server` over stdio, validates the initialize handshake, and exercises native `thread/goal/set|get|clear`; `--require-embedded` requires `vendor/codex-bin` and is used by release checks.

## Frontend Scripts

- `scripts/frontend/attention-smoke.cjs` - Validates the shared terminal attention helpers used to decide whether sidebar workspace dots should appear and when unread attention is cleared.
- `scripts/frontend/workspace-smoke.cjs` - Validates empty-install workspace startup, project folder removal wiring, and sidebar remove control styling.
- `scripts/frontend/session-launch-smoke.cjs` - Validates launch/resume command construction and launch-mode gating, and guards that the terminal-creation effect stays decoupled from the command string so a resume id discovered mid-session cannot blank a live pane.
- `scripts/frontend/fusion-settings-smoke.cjs` - Locks the Fusion settings layer: per-engine and per-model effort support (including safe GPT-5.5/Luna fallbacks), planning-model validation before restart, menu-activation trap fixes (/claude submenu, empty fallback, Shift+Tab gate), curated GPT-5.6 catalogs, and transcript preservation across settings restarts.
- `scripts/frontend/cwd-conflicts-smoke.cjs` - Validates the shared-working-folder helpers (normalization, boundary-safe nesting, terminal exclusion, active escalation) and grep-locks the chip wiring in App, the three panes, and the CSS.
- `scripts/frontend/tiled-board-resize-smoke.cjs` - Validates tiled-board resize geometry for directional neighbor pushes, edge detaching, multi-neighbor clamping, and no-overlap release behavior.

## QA Scripts

- `scripts/qa/screenshot.cjs` - Starts the Vite frontend and Electron in screenshot mode, captures the visible app window, verifies the PNG exists, and writes `artifacts/vibe-terminal-screenshot.png`. Pass `--openfusion` to seed a deterministic Open Fusion pane and write `artifacts/vibe-terminal-openfusion-screenshot.png`.

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
- `npm run screenshot:openfusion` - Visual QA screenshot pass for the Open Fusion chat pane fixture.
- `npm run smoke:backend:codex-discovery` - Backend smoke test for Codex thread discovery.
- `npm run smoke:backend:claude-discovery` - Backend smoke test for Claude thread discovery.
- `npm run smoke:backend:agent-telemetry` - Backend smoke test for vibeTerminal-owned agent telemetry shims.
- `npm run smoke:backend:code-changes` - Backend smoke test for code-change tracking.
- `npm run smoke:backend:launch-cwd` - Backend smoke test for terminal/Fusion launch cwd validation.
- `npm run smoke:backend:updates` - Backend smoke test for update policy and silent Windows update apply behavior.
- `npm run smoke:backend:fusion-launch` - Backend smoke test for Fusion prompt/MCP launch files.
- `npm run smoke:backend:fusion-adapter` - Backend smoke test for the Fusion adapter MCP tools.
- `npm run smoke:backend:fusion-chat-parse` - Backend smoke test for Fusion headless Claude stream parsing.
- `npm run smoke:backend:openfusion-background-status` - Backend smoke test for Open Fusion detached-task status snapshots and MCP reads.
- `npm run smoke:backend:completion-gate` - Backend smoke test for the completion-gate tracker (verified/unverified detection + one-shot nudge).
- `npm run smoke:backend:openfusion-chat-parse` - Backend smoke test for Open Fusion OpenCode SSE parsing.
- `npm run smoke:backend:openfusion-isolation` - Backend smoke test for Open Fusion data ownership (app-owned OpenCode home, threads-only migration, no default models, discovery env overrides).
- `npm run smoke:backend:openfusion-custom-provider` - Backend smoke test for Open Fusion custom OpenAI-compatible providers (config patch shape, removal rewrite, id derivation, wiring contracts).
- `npm run smoke:frontend:fusion-settings` - Frontend smoke test for the Fusion settings layer (per-engine efforts, model validation, menu trap fixes).
- `npm run smoke:backend:fusion-appserver` - Backend smoke test for Codex app-server initialize over stdio, with optional PATH fallback.
- `npm run smoke:backend:fusion-appserver:embedded` - Backend smoke test requiring the embedded Codex binary.
- `npm run smoke:frontend:attention` - Frontend smoke test for terminal attention helper behavior.
- `npm run smoke:frontend:workspace` - Frontend smoke test for workspace startup and project folder removal behavior.
- `npm run smoke:frontend:session-launch` - Frontend smoke test for launch/resume command building and terminal-pane launch decoupling.
- `npm run smoke:frontend:cwd-conflicts` - Frontend smoke test for the shared-working-folder chip helpers and wiring.
- `npm run smoke:frontend:tiled-resize` - Frontend smoke test for tiled-board resize geometry and no-overlap release behavior.
- `npm run smoke:codex-discovery` - Compatibility alias for the backend smoke test.
