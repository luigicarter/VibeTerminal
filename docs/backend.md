# Backend

The `backend/` folder contains Electron main-process code and Node-side terminal/session helpers.

## Files

- `backend/main.cjs` - Electron app entry point from `package.json`; creates the BrowserWindow, starts child hosts, owns IPC handlers, handles folder selection, and brokers latest-agent-thread lookups.
- `backend/codeChanges.cjs` - Runs and parses read-only Git status and diff checks for workspace code-change tracking.
- `backend/launchCwd.cjs` - Validates terminal/Fusion launch working directories before child processes or Cursor hook setup can use them.
- `backend/ptyHost.cjs` - Child process that owns `node-pty` terminal sessions, buffers scrollback, forwards terminal data, resizes sessions, kills sessions, and emits JSONL events to the main process.
- `backend/agentTelemetry.cjs` - Creates vibeTerminal-owned per-pane agent shims, starts the local telemetry callback server, installs per-turn notification hooks for the threaded agents, maps agent lifecycle events to pane attention events, and removes stale owned shim directories.
- `backend/agentThreadHost.cjs` - Child process that performs Codex, Claude, OpenCode, and Cursor thread metadata discovery so filesystem scans and CLI lookups do not block Electron main or terminal IPC. A `confirmId` lookup payload asks whether one specific id is still resumable (returns `found`/`missing`) so the renderer can self-heal a doomed resume into a fresh launch; this is supported for all four providers (`confirmClaudeThread`, `confirmCodexThread`, `confirmOpenCodeThread`, `confirmCursorThread`). Cursor discovery reads `~/.cursor/projects/<encoded-cwd>/agent-transcripts/<chatId>/<chatId>.jsonl` (the cwd is encoded by dropping `:` and collapsing path separators into `-`); the newest transcript dir is the latest resumable chat and resume launches `cursor-agent --resume <chatId>`.
- `backend/agentThreads.cjs` - Codex thread discovery utilities used by the discovery host and smoke tests; reads local Codex session metadata and returns pending, found, ambiguous, or failed lookup results. Also exposes `confirmCodexThread`, which checks whether a specific rollout id still exists by the `rollout-<ts>-<id>.jsonl` filename (no contents read) and returns `found`/`missing`.
- `backend/fusionChatHost.cjs` - Child process for Fusion panes. It launches the user's global `claude` in headless stream-json mode, normalizes Claude events, and uses a per-pane MCP config so Claude can call the Fusion Codex adapter.
- `backend/fusion-adapter.cjs` - MCP stdio server launched by Claude for Fusion. It owns one embedded `codex app-server` child over stdio, starts a pane-scoped Codex thread, parks approval/question requests for Opus, and relays Codex progress back through telemetry.

## Runtime Flow

- `backend/main.cjs` starts `backend/ptyHost.cjs` with Node.
- `backend/main.cjs` starts `backend/agentThreadHost.cjs` with Node for agent-thread discovery requests.
- `backend/main.cjs` starts `backend/fusionChatHost.cjs` on first Fusion pane start and resolves the embedded Codex binary path. Packaged builds fail closed if `resources/codex-bin/<platform>-<arch>/codex(.exe)` is missing; dev builds may fall back to PATH `codex`.
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

A separate `agent.running` type reports turn **start** (the sidebar "working" spinner). The server does
not turn it into attention/unread; it emits a dedicated `agent-running` event the renderer maps onto
`session.status = "running"` (see `docs/frontend.md`). claude, opencode, and cursor produce it — they have
a turn-start signal; codex does not, so its working state stays on the output heuristic (a human
keystroke into the pane is what releases a done/failed pill there — see `statusAfterUserInput` in
`docs/frontend.md`).

Hooks may pass a whitelisted second argument (`detail`: `tool`/`approval`/`question`/`turn-start`) that
the notify program forwards. `agent.running` with detail `tool` is emitted as `turnStart:false`: the
hook POSTs ride independent short-lived processes with no ordering guarantee, so only a genuine turn
start may override a finished done/failed pill — a tool hook racing past the turn's `Stop` cannot
resurrect the spinner. `agent.waiting` details become the attention `reason` (`approval` vs `question`).

- **claude** - launched with `--settings <runDir>/claude-settings.json` (injected by the shim).
  `UserPromptSubmit` fires `agent.running` (undetailed = genuine turn start);
  `PreToolUse`/`PostToolUse` fire `agent.running tool` (mid-turn activity, latch-respecting);
  `Stop` fires `agent.completed`; `Notification` is split — `permission_prompt` fires
  `agent.waiting approval`, `idle_prompt` fires `agent.waiting question` — so the renderer can flip
  waiting->running on the user's answer keystroke for approvals only (approving has no hook of its
  own: PreToolUse fires before the prompt, PostToolUse only when the tool ends).
- **codex** - launched with `-c notify=[...]` (injected by the shim) pointing at the per-run notify
  program. codex only emits turn-complete, so it maps to `agent.completed` (no `agent.running`).
  codex appends its own JSON payload as an extra argument; the detail whitelist drops it.
- **opencode** - a guarded global plugin in the user's opencode config dir (installed idempotently;
  rewritten only when `OPENCODE_PLUGIN_VERSION` changes — bump it with ANY source change; no-ops
  unless the `VIBE_TERMINAL_*` env vars are set). Maps `session.idle`->`agent.completed`,
  `permission.asked/updated`->`agent.waiting` (detail `approval`), `session.error`->`agent.failed`,
  and infers `agent.running` from the first `message.*` stream event per turn, throttled by a `busy`
  latch. The latch drops on EVERY mapped event — the approval that resumes a permission-paused turn
  has no event of its own, so the next `message.*` burst must be free to re-assert "working".
  Child sessions (task-tool subagents, e.g. the Open Fusion executor) are tracked via the `parentID`
  on `session.created/updated` info and their `session.idle`/`session.error` are ignored — a child
  finishing is not the pane's turn ending (payload shapes verified against opencode 1.17.11;
  unknown shapes fail open to no filtering). Permission asks are never filtered: the user answers
  them in this TUI whichever session raised them.
  The exact `message.*` names are live-verify pending: if they differ the spinner just won't show (no
  false positive) while done/waiting still flow.
- **cursor** - Cursor's CLI hooks only load from `~/.cursor/hooks.json` or a project
  `<cwd>/.cursor/hooks.json` (no per-invocation flag), and they fire only in the interactive TUI,
  not `-p`/headless print mode. `ensureCursorProjectHooks(cwd)` (called from `terminal:create` when
  the launch command is `cursor-agent`) idempotently **merges** env-guarded `beforeSubmitPrompt` and
  `stop` hooks into the project `.cursor/hooks.json`, preserving the user's own hooks. Both invoke one
  notify program (`vibeterminal-cursor-notify.ps1`/`.sh`): `beforeSubmitPrompt` passes the type as an
  argument (`agent.running`, the turn-start spinner) while `stop` passes none and the program derives
  the type from the JSON `status` piped on stdin — `completed`->`agent.completed`,
  `error`->`agent.failed`, `aborted`->`agent.waiting` (an interrupted turn is not "done"; it is the
  user's turn) — stdin is always drained so a large payload never blocks the hook. Entries are tagged by the marker
  in the notify filename so they are refreshed (not duplicated) across runs and stripped on cleanup (a
  file we created is removed outright). `agent.waiting` is intentionally **not** wired: Cursor's only
  permission hooks (`beforeShellExecution`) *decide* permission, so observing them for a "waiting"
  signal would risk altering approval behavior. If hooks can't be installed (read-only repo, or an
  existing malformed `hooks.json` we won't clobber), Cursor degrades to the shim's exit-code
  completed/failed only.

The notify program is `notify.ps1` on Windows and a Node `notify-hook.cjs` via `notify.sh` on POSIX,
written per run next to `shim-runner.cjs`. The shim still posts `agent.process.exited` as a
crash/quit fallback (this gives every provider, Cursor included, an exit-code completed/failed
signal even when no per-turn hook fires). Covered by `npm run smoke:backend:agent-telemetry`.
