# Codex idle composer sparkle: `tui.whimsy=false` on every Codex-family launch

September 13, 2026. Codex CLI 0.154 repaints its **empty** composer forever. Every
Codex-family pane Lina launches now carries `-c tui.whimsy=false` at the active
command level, so an idle Codex pane produces no PTY output at all.

## What 0.154 added

`tui/src/bottom_pane/chat_composer/sparkle.rs` is new in 0.154 (that path and the
eight single-dot braille glyphs `⠁⠂⠄⠈⠐⠠⡀⢀` sit together in the 0.154 binary; the
module does not exist in the pre-0.144 source vendored under
`apps/desktop/vendor/codex-official`). It is an ambient twinkle around the empty
composer: every synchronized frame (`CSI ?2026h … ?2026l`, ~1 KB) recolours ~30
braille cells on the composer rows — including the cursor row, to the right of the
cursor — and ends with the per-frame cursor-style repair (`CSI 0 SP q`). Upstream
gates it on the `whimsy` and `animations` settings, TrueColor, a model name
matching `astra` (the user's default is `gpt-6-astra`) and no open popup.

The cost is not cosmetic: every frame is decoded in the main process, repainted by
the renderer and streamed by the mobile bridge, forever, per idle pane. It also
makes an idle pane look permanently "changed" to anything that watches output
volume.

`docs/codex-cursor-flicker-2026-09-11.md` states that an idle composer emits no
bytes. That was true of 0.144 and is no longer true of 0.154.

### Measured on the real launch path

A `codex` pane launched through the production chain (telemetry shim PATH →
PowerShell pane → `codex.cmd` → `codex.ps1` → global codex 0.154), bundled ConPTY,
100×30, TrueColor, `gpt-6-astra`, measured over a 15 s window starting 4 s after the
composer appeared:

| Launch | Idle PTY chunks / 15 s | Idle bytes / 15 s |
| --- | --- | --- |
| `codex`, no override (control) | 261 | 102,656 |
| `codex`, no override (second control run) | 283 | 103,280 |
| `codex`, `-c tui.whimsy=false` | 0 | 0 |
| `codex`, `-c tui.whimsy=false` (second run) | 4 | 77 |
| `codex resume <id>`, `-c tui.whimsy=false` | 0 | 0 |

That is ~17 chunks and ~6.8 KB per second of pure decoration, reduced to nothing.
The 4 chunks / 77 bytes in one run are ordinary status-line traffic, not the
sparkle.

`-c tui.animations=false` silences the same loop, but it also removes the welcome
animation, shimmer and spinners. `whimsy` is the narrow switch (new in 0.154,
beside `animations` in the `[tui]` field list), so that is the one Lina sets.

## Where the override is set

One list, `CODEX_TUI_CONFIG_OVERRIDES` in `backend/agentTelemetry.cjs`, published to
every pane as **`VIBE_TERMINAL_CODEX_TUI_OVERRIDES`** (a JSON array of `-c` strings,
currently `["tui.whimsy=false"]`) alongside the existing hook env.

It is deliberately **not** part of `codexHookOverrides`
(`VIBE_TERMINAL_CODEX_HOOK_OVERRIDES`): that list is consumed by
`backend/openCodexCli.cjs` as the lifecycle-hook definitions, and
`codexLifecycleTrustOverride` hashes exactly those handlers. An extra entry there
would change hook identity and break hook trust.

Consumers, all appending at the **active command** level — never at root, because
Codex can discard root `-c` values when a subcommand also carries `-c`
(`backend/codexWebNative.cjs:52-58`):

- `backend/agentTelemetry.cjs` PowerShell wrapper (`codex.ps1`, the Windows pane
  path) — appended after the user's arguments and after the hook overrides.
- `backend/agentTelemetry.cjs` node shim runner (the POSIX pane path) — same place.
  Both now apply the TUI overrides for `provider === "codex"` independently of
  `VIBE_TERMINAL_NOTIFY_PROGRAM`, so a pane without lifecycle telemetry still does
  not repaint while idle.
- `backend/openCodexCli.cjs` — appended after `argv`, so `open-codex resume <id>`
  carries it too.
- `backend/codexWebNative.cjs` `nativeArgs` — Codex Web builds its own argument
  list, so the switch is one of its own `-c` flags; its existing merge keeps every
  override at command level and still lets an explicit user `-c` win (user
  overrides are merged last).

A malformed or absent list is ignored in every consumer: the pane launches without
the switch rather than failing.

### Argv actually received, captured through the real pane

`codex resume <id>`, with a stand-in for the real executable placed first on
`VIBE_TERMINAL_ORIGINAL_PATH` so the shim resolves it exactly as it resolves codex:

```
[0]  -c
[1]  hooks.state={ 'C:\<session-flags>\config.toml:user_prompt_submit:0:0' = { trusted_hash = 'sha256:…' }, … }
[2]  resume
[3]  01a09d75-e79d-7621-a33b-eed37fe0612e
[4]  -c   [5] notify=['powershell',…,'agent.completed']
[6..19]   -c hooks.UserPromptSubmit=… … -c hooks.SessionStart=…
[20] -c
[21] tui.whimsy=false
```

The trust override stays prepended at root (explicit user CLI state must win); the
lifecycle hooks and the TUI override ride the `resume` command. `tui.whimsy=false`
appears exactly once, last. A fresh `codex` launch is the same list without
`resume <id>` (20 items, override at index 19).

## No version gate

`tui.whimsy` is unknown to Codex 0.144. It is **ignored, not rejected**, so there is
no version gate and `backend/cliProbe.cjs` is unchanged. Verified against the
retained 0.144.0 binary
(`apps/desktop/.tmp/codex-release-cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`)
with an isolated `CODEX_HOME`:

- `codex -c tui.whimsy=false login status` — identical output and exit code to the
  same command without the override. A deliberately bogus key
  (`-c tui.lina_nonsense_key=false`) behaves the same way, which is what identifies
  this as "unknown `[tui]` keys are ignored" rather than "this key happens to exist".
- 0.144 does report bad config loudly, so silence is meaningful: a wrong
  `wire_api` in the same probe config produced
  `Error loading config.toml: `wire_api = "chat"` is no longer supported.` and exit 1.
- TUI startup: 0.144 reached its composer (`>_ OpenAI Codex (v0.144.0)`, `model:
  probe-model`) identically with and without the override, no error text, 0 idle
  chunks in both (0.144 does not sparkle).

Bundled binaries (`vendor/codex-bin`, `vendor/open-codex`, `vendor/codex-web`) are
0.154.0, so `open-codex` and `codex-web` always get a CLI that understands the key.

## Lifecycle hooks are unaffected

- A fresh `codex` pane launched through the shim with the override active, then one
  tiny prompt: the manager received `agent-session:start` (the `SessionStart` hook),
  `agent-running` (`UserPromptSubmit`) and two `agent-attention` events.
- `hooks/list` over `codex app-server` on the bundled 0.154, run with and without
  the TUI override appended: **7/7** generated hooks `trusted` and `enabled` in both
  cases (`pre_tool_use, permission_request, post_tool_use, session_start,
  user_prompt_submit, subagent_start, subagent_stop`).
- `npm run smoke:codex:hook-trust` passes unchanged.

`SessionStart` fires when the conversation starts, not when the TUI paints, so an
idle pane that has never been prompted legitimately reports nothing.

## Verification

From `apps/desktop`:

- `node --test scripts/backend/codex-tui-overrides.test.cjs` — 12/12. Covers the
  frozen list and its separation from the hook list and the trust override; the env
  published by `prepareSession`; the node shim runner **and** the Windows
  PowerShell wrapper (override present exactly once, after the user args and after
  the hook overrides, still present after a `resume <id>` subcommand, still applied
  with no notify program, absent/malformed list launches normally);
  `openCodexCli.launchSpec` on a resume; and `codexWebNative.nativeArgs` on fresh,
  resumed, and user-override argument lists.
- `node --test scripts/backend/codex-hook-trust.test.cjs scripts/backend/open-codex.test.cjs
  scripts/backend/codex-web.test.cjs scripts/backend/codex-web-protocol.test.cjs
  scripts/backend/codex-web-browser-login.test.cjs scripts/backend/chat-codex-web.test.cjs`
  — 113/113.
- `npm run test:codex-web` — 90/90 (78 before, plus the 12 new). The new suite is
  listed there because that script is one of `scripts/qa/release-checks.cjs`'s
  gates; no existing glob would have picked the file up.
- Telemetry suites `provider-status-telemetry`, `claude-task-telemetry`,
  `observed-stop-telemetry`, `grok-telemetry`, `chat-selection-telemetry`,
  `fusion-observed-stop-telemetry` — 34/34.
- `node scripts/backend/agent-telemetry-smoke.cjs`,
  `node scripts/backend/agent-generation-telemetry-smoke.cjs`,
  `node scripts/backend/open-codex-native-smoke.cjs`,
  `node scripts/qa/codex-web-tui-smoke.cjs` (`{"ok":true,"nativeTui":true,…}`) — all pass.

## Not verified

- **Codex Web's own idle repaint was not measured live.** Its argument list is
  covered by unit test and a real native TUI launch (`codex-web-tui-smoke`) passes,
  but that smoke uses a fixture model catalog rather than a signed-in Astra Work
  session, which is the configuration the sparkle needs.
- **Open Codex's idle repaint was not measured live** either; only its argument
  list and its native smoke. Open Codex runs user-configured models, whose names
  rarely match upstream's `astra` gate.
- **Hooks firing on a resumed launch were not observed end-to-end.** The resumed
  pane reached its composer with the transcript restored and zero idle output, and
  its captured argv carries the same trust override and seven hook overrides, but
  the probe harness could not get typed input into a resumed 0.154 TUI, so no turn
  ran there. Hook firing was observed on the fresh launch only.
- macOS/Linux: only the node shim runner path is unit-tested there; every live
  measurement in this document is Windows 11 with bundled ConPTY.
- Nothing here changes the input freshness fence; see the input-surface work for
  that. Panes running a Codex build the user installed themselves are covered too,
  since the override is passed on the command line rather than written to config.
