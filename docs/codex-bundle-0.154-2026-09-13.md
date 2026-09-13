# Bundled Codex pin 0.144.0 → 0.154.0 (2026-09-13)

The single vendored Codex pin moved from 0.144.0 to 0.154.0 because the user's
own `~/.codex/config.toml` — written by Codex CLI 0.154.0 — is unreadable by
0.144.0, and every Lina surface that runs the **bundled** binary against the
**user's global Codex home** inherited that failure.

## The failure

`~/.codex/config.toml` line 18 holds a table the older binary does not know:

```toml
[agents]
default_subagent_model = "gpt-6-astra"
default_subagent_reasoning_effort = "low"
max_threads = 6
max_depth = 1
```

0.144.0 expects `agents` to be a map of role name → `AgentRoleToml`, so the
string value is a hard type error rather than an ignorable unknown key:

```
Error loading config.toml: invalid type: string "gpt-6-astra", expected struct AgentRoleToml
in `agents`
```

Reproduced on 2026-09-13 through the real launch path — the command
`frontend/sessionLaunch.ts` builds for a fresh Codex pane (`codex`), run through
a real `backend/agentTelemetry.cjs` session shim (7 invocation-scoped `-c` hook
overrides + the trust override) under `node-pty` on the bundled ConPTY host that
`backend/ptyHostOptions.cjs` selects, with the user's real `CODEX_HOME`:

| Surface (bundled 0.144.0, user's real `~/.codex`) | Result |
|---|---|
| TUI (`codex`) | exits 1 on the error above; no composer |
| `codex app-server` (Fusion planner/executor, `backend/fusionCodexBrain.cjs`) | `initialize` succeeds, but stderr logs `Invalid configuration; using defaults` — the user's model, approval policy, sandbox mode and project trust are silently dropped |
| `codex debug models` (Fusion's model catalog, `backend/codexModels.cjs`) | hard error, empty catalog |

Two surfaces were **not** affected and did not need the bump:

- A `codex` provider pane on this machine. The pane shim resolves `codex` from
  the user's own PATH (`VIBE_TERMINAL_ORIGINAL_PATH`), and the app never puts
  `codex-bin` on a pane's PATH — so the pane was already starting on the user's
  global 0.154.0 CLI. The bundle only becomes the pane's CLI if the user has no
  global `codex`.
- Open Codex and Codex Web, which run their own bundles against their own
  app-owned homes (`%APPDATA%\vibe-terminal\open-codex`, the Codex Web home),
  never the user's `~/.codex`.

The bundled binary reaches the user's home because
`backend/agentTelemetry.cjs` deliberately pins `CODEX_HOME` to
`~/.codex` for the embedded binary so Fusion reuses the user's ChatGPT login
without re-auth. That is the intended behavior; it only means the bundled
binary must be new enough to parse whatever the user's current CLI writes.

## What changed

The pin has one source of truth: the single directory name under
`vendor/codex-appserver/`. Everything else derives from it
(`scripts/dev/prepare-codex-bin.cjs`, `scripts/backend/fusion-appserver-smoke.cjs`,
`scripts/qa/verify-release-artifacts.cjs`, `scripts/dev/model-drift.cjs`, and the
release workflow's `npm install -g "@openai/codex@$version"`).

- `vendor/codex-appserver/0.144.0/` removed; `vendor/codex-appserver/0.154.0/`
  regenerated with `npm run gen:codex-bindings` (847 `.ts` + 305 schema files).
- `vendor/codex-bin/win32-x64` re-prepared at 0.154.0 from an isolated
  `@openai/codex@0.154.0` install (the documented `VIBE_CODEX_BIN_SEARCH_ROOTS`
  procedure in `docs/windows-release.md`); the user's global CLI was not changed.
- `vendor/open-codex/win32-x64` re-prepared from that payload
  (`npm run prepare:open-codex`) — Open Codex shares the same pin, so the two
  bundles stay coherent. Codex Web is a separate pin that was **already** at
  0.154.0 (`scripts/dev/prepare-codex-web-cli.cjs`), so all three now agree.
- Comments and docs that named 0.144.0 as the current pin were updated
  (`backend/fusionCodexBrain.cjs`, `backend/fusion-adapter.cjs`,
  `backend/agentTelemetry.cjs`, `frontend/components/fusionSlashMenu.ts`,
  `scripts/dev/prepare-codex-bin.cjs`, `scripts/frontend/fusion-settings-smoke.cjs`,
  `docs/open-codex.md`, `docs/fusion-terminal.md`).

### Protocol drift 0.144.0 → 0.154.0

The generated app-server bindings are additive for everything Fusion drives.
`ClientRequest` keeps `initialize`, `thread/start`, `thread/resume`,
`turn/start`, `turn/steer`, `turn/interrupt`, `hooks/list`, `model/list` and the
goal methods, and adds new families (`project/*`, `threadSection/*`,
`thread/queue/*`, `userVerification/*`, …). `TurnStartParams` and
`ThreadStartParams` only gained optional fields. `ThreadItem` gained a
`functionCallOutput` variant and moved `sleep` onto a `SleepItem` shape. One
type was removed: `AmazonBedrockCredentialSource`, which Lina never referenced.

### Effort and model catalog

0.154.0's live catalog exposes `low|medium|high|xhigh|max|ultra`. `minimal` is
gone; it survives in `CODEX_EFFORT_LABELS` only so a saved legacy value still
normalizes (to `low`) instead of dropping a pane's effort selection. The curated
per-model effort matrix the Fusion picker enforces still matches the live one
for every curated id it covers.

## Verified on 2026-09-13 (this machine, bundled 0.154.0, user's real `~/.codex`)

- Codex pane reaches its composer with the user's own settings applied:

  ```
  ╭──────────────────────────────────────────────────────────╮
  │ >_ OpenAI Codex (v0.154.0)                               │
  │ model:       gpt-6-astra xhigh   /model to change        │
  │ permissions: YOLO mode                                   │
  ╰──────────────────────────────────────────────────────────╯
  › Ask Codex to do anything
  ```

- The 7 invocation-scoped hook overrides and the trust override are accepted
  and lifecycle events reach the telemetry callback. One tiny prompt produced,
  in order: `agent.session` (SessionStart, with `providerThreadId`),
  `agent.running` `detail:"turn-start"` (UserPromptSubmit, with
  `providerThreadId` + `providerTurnId`), then two `agent.completed` notify
  posts — mapped by the manager to `agent-session:start`, `agent-running`,
  `agent-attention` ×2.
- `npm run smoke:codex:hook-trust` (against the new bundle): all four native
  assertions pass — seven generated hooks trusted, user/project hooks still
  untrusted, persisted/CLI disablement and explicit CLI trust take precedence,
  changed command requires a matching new hash. The trust hashing is unchanged
  in 0.154.0.
- `npm run smoke:backend:fusion-appserver:embedded` passes; a direct
  `app-server` `initialize` against the real home now returns clean with **no**
  `Invalid configuration` stderr.
- `codex debug models` against the real home returns the full catalog again.
- `npm run smoke:backend:conpty-host` still passes (bundled OpenConsole host,
  no leaked console hosts).

## Not verified

- No packaged build or release was produced, so
  `scripts/qa/verify-release-artifacts.cjs` and
  `npm run smoke:open-codex:packaged` were not run against a 0.154.0 installer.
- Only `win32-x64` was re-prepared; no other platform bundle exists locally.
- A real Fusion planner/executor delegation turn was not run (quota); the
  app-server evidence is the handshake, the feature-override smoke, and the
  adapter/chat-parse smokes.
- `backend/codexWebNative.cjs` still carries a "Codex 0.144 can discard root
  `-c` values when a subcommand also has `-c`" note; that workaround was not
  re-measured against 0.154.0 (Codex Web was already pinned at 0.154.0 before
  this change).
- `npm run check:model-drift` reports curated-catalog drift that this change did
  not address: `gpt-daybreak-blue-latest` and `gpt-5.3-codex-spark` are missing
  from the curated Fusion list, `gpt-6-astra` now also serves `ultra`, and
  `gpt-5.4-mini` is no longer served upstream. Those are curation decisions, not
  part of the pin bump.
