# Backend

The `backend/` folder contains Electron main-process code and Node-side terminal/session helpers.

## Files

- `backend/main.cjs` - Electron app entry point from `package.json`; creates the BrowserWindow, starts child hosts, owns IPC handlers, handles folder selection, and brokers latest-agent-thread lookups.
- `backend/codeChanges.cjs` - Runs and parses read-only Git status and diff checks for workspace code-change tracking.
- `backend/launchCwd.cjs` - Validates terminal/Fusion launch working directories before child processes or Cursor hook setup can use them.
- `backend/ptyHost.cjs` - Child process that owns `node-pty` terminal sessions, buffers scrollback, forwards terminal data, resizes sessions, kills sessions, and emits JSONL events to the main process. On Windows it starts interactive PowerShell panes with UTF-8 console encodings (`[Console]::InputEncoding`/`OutputEncoding`) so ConPTY's default OEM code page cannot mangle node TUIs' UTF-8 box-drawing into mojibake.
- `backend/agentTelemetry.cjs` - Creates vibeTerminal-owned per-pane agent shims, starts the local telemetry callback server, installs per-turn notification hooks for the threaded agents, maps agent lifecycle events to pane attention events, and removes stale owned shim directories.
- `backend/agentThreadHost.cjs` - Child process that performs Codex, Claude, OpenCode, Cursor, and Kimi thread metadata discovery so filesystem scans and CLI lookups do not block Electron main or terminal IPC. A `confirmId` lookup payload asks whether one specific id is still resumable (returns `found`/`missing`) so the renderer can self-heal a doomed resume into a fresh launch; this is supported for all five providers (`confirmClaudeThread`, `confirmCodexThread`, `confirmOpenCodeThread`, `confirmCursorThread`, `confirmKimiThread`). Cursor discovery reads `~/.cursor/projects/<encoded-cwd>/agent-transcripts/<chatId>/<chatId>.jsonl` (the cwd is encoded by dropping `:` and collapsing path separators into `-`); the newest transcript dir is the latest resumable chat and resume launches `cursor-agent --resume <chatId>`. Kimi discovery reads `$KIMI_CODE_HOME/session_index.jsonl` (one `{sessionId, sessionDir, workDir}` line per session — the index is global, so entries are filtered to the folder) plus each session's `state.json` (`title`, falling back to `lastPrompt`; ISO timestamps); the newest by `updatedAt` is the latest resumable session and resume launches `kimi --session <id>`. kimi-custom discovery reuses the same parsers against the same shared home as stock kimi ($KIMI_CODE_HOME or `~/.kimi-code`), labels refs `kimi-custom`, and resumes via `kimi-custom --session <id>`.
- `backend/agentThreads.cjs` - Codex thread discovery utilities used by the discovery host and smoke tests; reads local Codex session metadata and returns pending, found, ambiguous, or failed lookup results. Also exposes `confirmCodexThread`, which checks whether a specific rollout id still exists by the `rollout-<ts>-<id>.jsonl` filename (no contents read) and returns `found`/`missing`. Published refs carry a generated title: Codex rollouts virtually never have a `session_meta.name`, so the first real `user_message` in the rollout head is harvested (lazily — only for refs actually returned), normalized to a capped one-liner by `normalizeThreadTitle`. Claude discovery/confirm harvests titles the same way in `agentThreadHost.cjs`: a non-generic `custom-title` head line (a deliberate rename) wins, otherwise the first real prompt (slash-command envelopes, caveat banners, assistant/summary/meta lines skipped). Launches never pass `claude --name` — that stamped the pane's placeholder label over the generated title in Claude's own `/resume` picker.
- `backend/fusionChatHost.cjs` - Child process for Fusion panes. It launches the user's global `claude` in headless stream-json mode, normalizes Claude events, and uses a per-pane MCP config so Claude can call the Fusion Codex adapter. Resumes REHYDRATE the visible transcript: `claude --resume`/codex `thread/resume` load context silently, so the host rebuilds the pane from the on-disk record (claude project JSONL via `locateClaudeTranscriptFile`, codex rollout via `locateCodexRollout`) — user prompts (harness envelopes unwrapped by `unwrapFusionUserText`, the inverse of `buildFusionInputContent`) and assistant prose, tail-capped, emitted `replay:true` (status/attention-neutral), pushed to history for remount replays, bypassing the completion-gate tracker, and settled with a `result subtype:"restored"`. Fusion fast serving is live: Claude planners start with inline `--settings {"fastMode":...}` and then receive stream-json `control_request` messages with `subtype:"apply_flag_settings"` and `settings:{fastMode}`; Codex planners call `thread/settings/update` with `serviceTier`.
- `backend/openFusionChatHost.cjs` - Child process for Open Fusion panes. It spawns one `opencode serve` per pane (pane-scoped `OPENCODE_*` env plus `XDG_DATA_HOME`/`XDG_CONFIG_HOME` pointed at the app-owned OpenCode home — threads, credentials, and global-config lookups never touch the user's personal OpenCode install; random per-pane basic-auth password, port parsed from stdout), creates or resumes the pane session over the server HTTP API, subscribes to the `/event` SSE feed, and normalizes OpenCode events (delta-vs-snapshot text dedupe per part id, task child sessions mapped to executor/investigator roles, permission asks/replies, abort-flavored errors suppressed) into the same high-level chat-event vocabulary the Fusion pane speaks. `tool-result` events carry a slim `meta` slice of OpenCode's tool `state.metadata` (`diff` for edit, `count`/`matches` for glob/grep — live and rehydrated paths both) so the pane renders OpenCode-style diff blocks and match counts. Resume rehydrates the transcript from `GET /session/{id}/message`. Turns without an explicit Brain model are refused (no default models by design). Fresh panes create NO session at boot: creation is deferred to the first input (`ensureSession`, serialized behind a promise) and the session is created **titled with that first prompt** — the eager create used to mint a ghost "vibeTerminal Open Fusion" session on every pane start/app boot, and opencode never re-titles a session created with an explicit title, so the resume picker drowned in identical-titled empty rows. The serve's readiness ping for the renderer's provider prefetch is the `engine-ready` event; the saved-chat listing additionally hides legacy ghosts (`updated === created`) in `agentThreadHost.listOpenCodeThreads`.
  The host keeps active executor children in `activeExecutorTasks` keyed by child `sessionID`, emits `task-child` so the renderer can bind late child ids to Task rows, and routes mid-turn steering through a hidden Planner pass that selects a target `childSessionId` for inject/replan.
- `backend/fusion-adapter.cjs` - MCP stdio server launched by Claude for Fusion. It owns one embedded `codex app-server` child over stdio, starts a pane-scoped Codex thread, parks approval/question requests for Opus, and relays Codex progress back through telemetry. Executor fast serving is per-delegation: Codex uses `config:{"features.fast_mode":true}` plus top-level `serviceTier:"priority"` when the selected model advertises that tier (otherwise `serviceTier:null` and a concise standard-serving note); Claude executor children start with `--settings {"fastMode":...}` and receive live `apply_flag_settings` control requests when only `executorFast` changes.

## Runtime Flow

- `backend/main.cjs` starts `backend/ptyHost.cjs` with Node.
- `backend/main.cjs` starts `backend/agentThreadHost.cjs` with Node for agent-thread discovery requests. Open Fusion lookups (`openFusion: true` on `agent-thread:latest`) get the app-owned OpenCode home's XDG env injected so `opencode session list` reads the app store; plain opencode panes keep the user's global store. `agent-thread:list` (the resume pickers' saved-chat history) rides the same host with a `list: true` payload. Claude/codex listings (the Fusion picker) and kimi/kimi-custom listings (the plain resume pickers) pass straight through — claude/codex/kimi chats live in the user's own global stores, exactly where `--resume`/`thread/resume`/`kimi --session` read from, and kimi-custom chats live in its app-owned home; `payload.fusion` keeps claude listings to harness-created chats (headless SDK launches record `entrypoint:"sdk-cli"`, interactive pane chats `"cli"`). The opencode path stays FAILED CLOSED: it refuses non-Open-Fusion payloads rather than fall through to the user's global store, and main raises the lookup's `after` cutoff to `agentTelemetry.getOpenFusionThreadCutoffMs()` (the migration marker's `migratedAt`) so personal CLI threads that rode along in the seeded db snapshot never surface. In the host, `listOpenCodeThreads` shares `selectOpenCodeThreadRefs` (folder match, cutoff, exclusions, newest-first) with latest-discovery and hides untouched ghosts (`updated === created`); an empty store prints nothing with exit 0 and is reported as an empty list, not a failure. `listClaudeThreads`/`listCodexThreads` sort newest-first by `updatedAt` and de-dup by id; claude titles prefer a non-generic `custom-title`, then the generated `ai-title` head record, then the first real prompt.
- `backend/main.cjs` starts `backend/fusionChatHost.cjs` on first Fusion pane start and resolves the embedded Codex binary path. Packaged builds fail closed if `resources/codex-bin/<platform>-<arch>/codex(.exe)` is missing; dev builds may fall back to PATH `codex`.
- `backend/main.cjs` starts `backend/openFusionChatHost.cjs` on first Open Fusion pane start (`openfusion-chat:*` IPC channels; per-pane config comes from `agentTelemetry.prepareOpenFusionFiles`, and model picks persist through `agentTelemetry.updateOpenFusionModels`).
- `backend/main.cjs` starts the local agent telemetry manager and enriches each terminal launch with vibeTerminal-only shim environment variables.
- The renderer talks to `backend/main.cjs` through the preload bridge.
- `backend/main.cjs` forwards terminal commands to the PTY host over stdin and broadcasts PTY events back to all renderer windows.
- Production Electron loads `dist/index.html`; development Electron loads the Vite URL from `VITE_DEV_SERVER_URL`.

## Agent notifications (folder attention dot)

The left-sidebar attention dot is driven by `agent-attention` events the telemetry callback server
(`backend/agentTelemetry.cjs`) emits and the renderer maps onto `session.attention`. Per-turn signals
come from each agent's native hook/notify mechanism, which POSTs `{type, sessionId, launchNonce}` to the callback
URL the shim injects (`VIBE_TERMINAL_CALLBACK_URL` / `_TELEMETRY_TOKEN` / `_SESSION_ID` / `_LAUNCH_NONCE`). The callback rejects released sessions and prior-launch nonces, so a delayed hook cannot settle a restarted pane. Each hook
reports `sessionId = VIBE_TERMINAL_SESSION_ID` (the pane id), not the agent's own id.

A separate `agent.running` type reports turn **start** (the sidebar "working" spinner). The server does
not turn it into attention/unread; it emits a dedicated `agent-running` event the renderer maps onto
`session.status = "running"` (see `docs/frontend.md`). Claude, OpenCode, Cursor, Kimi, and a trusted passive
Codex `UserPromptSubmit` observer produce it. Codex keeps an Enter/watchdog compatibility fallback when
the observer has not been trusted or the installed CLI predates lifecycle hooks.

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
- **codex** - keeps `-c notify=[...]` for final completion, and also receives invocation-local passive
  `UserPromptSubmit`, `PermissionRequest`, `PreToolUse`, and `PostToolUse` observer hooks. The observer
  lives at a content-versioned app-owned path, so unchanged code keeps the same `/hooks` trust definition
  while an observer update requires review again. vibeTerminal never passes
  `--dangerously-bypass-hook-trust`, writes no user config, emits no hook stdout, and never answers an
  approval. Codex merges these invocation hooks with matching user/project/plugin hooks. Turn-scoped
  subagent hooks report the parent session id, so their tool activity correctly keeps the root turn
  running; explicit subagent event payloads are ignored defensively. Legacy notify remains the final
  signal because it fires only after Stop-hook continuation
  is resolved. Its appended `thread-id`/`turn-id` JSON is preserved; the renderer defers until root
  discovery and rejects child-thread or stale-turn completion.
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
- **kimi** - Kimi Code CLI reads hooks only from `$KIMI_CODE_HOME/config.toml` (`[[hooks]]` entries;
  no per-invocation flag, no project-level config), so `ensureKimiHooks()` (called from
  `terminal:create` when the launch command matches `kimi`) idempotently **merges** marker-tagged
  `# vibeterminal-kimi-notify` blocks into the user's config.toml, preserving their own hooks
  byte-for-byte; `cleanupKimiHooks` strips them on shutdown (a config file we created is removed
  outright). The hook commands invoke the shared notify program with claude-parity semantics:
  `UserPromptSubmit`->`agent.running` (undetailed turn start), `PreToolUse`/`PostToolUse`->
  `agent.running tool`, `PermissionRequest`->`agent.waiting approval`, `Stop`->`agent.completed`,
  `StopFailure`->`agent.failed`. The env guard keeps them inert for `kimi` runs outside vibeTerminal
  panes.

- **kimi-custom** - The vendored custom fork (ribbon label "Kimi + CC") rides the same
  config.toml hook channel as stock kimi, under its own marker
  (`# vibeterminal-kimi-custom-notify`) in the same shared home ($KIMI_CODE_HOME or
  `~/.kimi-code`) — login, theme, and session history carry over between the fork,
  standalone runs, and panes. `terminal:create` matches `kimi-custom` first (the stock
  `kimi` gate's regex excludes it via `(?!-)`), inserts `vendor/kimi-custom/bin` into
  the session PATH *after* the shim dir (so the shim wrapper keeps the process-exit
  fallback) and into `VIBE_TERMINAL_ORIGINAL_PATH` (so the shim runner resolves the
  real launcher), then `ensureKimiCustomHooks()` merges the identical claude-parity
  `[[hooks]]` set into the shared config.toml; `cleanupKimiCustomHooks` strips them on
  shutdown. The launcher (`bin/kimi-custom.cmd` / `bin/kimi-custom`) runs platform-key
  mode (kimi-k3 on Moonshot's Anthropic-compatible endpoint, 1M context) only when a
  key is available — the gitignored `vendor/kimi-custom/api.txt` takes precedence over
  `KIMI_MODEL_API_KEY` — and otherwise leaves the providers configured in
  `~/.kimi-code` (e.g. a subscription via `kimi-custom login`) in charge.

The notify program is `notify.ps1` on Windows and a Node `notify-hook.cjs` via `notify.sh` on POSIX,
written per run next to `shim-runner.cjs`. The shim still posts `agent.process.exited` as a
crash/quit fallback (this gives every provider, Cursor included, an exit-code completed/failed
signal even when no per-turn hook fires). Covered by `npm run smoke:backend:agent-telemetry`.
