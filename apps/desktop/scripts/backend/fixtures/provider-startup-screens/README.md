# Provider startup screen captures

Real PTY recordings of the first screen each supported coding CLI paints, taken
on 2026-09-13 on Windows 11 with the CLIs installed on that machine. They exist
because the Claude readiness detector was written against a synthetic fixture
and silently stopped matching the shipped Claude Code layout; every recognizer
in `backend/orchestratorPromptReadiness.cjs` is now grounded in one of these.

## What is here

For each capture `<name>`:

- `<name>.bin` — the raw bytes the PTY produced, exactly as `node-pty` delivered
  them (UTF-8, ANSI escapes intact). This is the recording; nothing is edited.
- `<name>.json` — `{ kind, cols, rows, observation, readiness }`, where
  `observation` is what `backend/terminalObservation.cjs` decodes from that
  recording and `readiness` is the verdict
  `backend/orchestratorPromptReadiness.cjs` returns for it.

`scripts/backend/orchestrator-prompt-readiness.test.cjs` ingests every `.bin`
through the real decoder and asserts the recorded cursor position and the
expected verdict, so a layout change in any provider fails a test instead of a
user's prompt.

| capture | CLI | screen | expected verdict |
| --- | --- | --- | --- |
| `claude-120x36` | Claude Code 2.1.270 | ready composer, auto mode, 120x36 | `ready`, cursor (2,6) |
| `claude-100x20` | Claude Code 2.1.270 | ready composer, manual mode, 100x20 | `ready`, cursor (2,16) |
| `claude-hidden-cursor-100x30` | Claude Code 2.1.270 | ready composer on a custom endpoint (Open Claude Code / `ANTHROPIC_BASE_URL`), cursor never shown, 100x30 | `ready`, cursor (2,6), `cursorVisible: false` |
| `codex-folder-trust` | Codex 0.154.0 | folder-trust prompt | `transient` `folder-trust`, affirmative default |
| `codex-ready` | Codex 0.154.0 | ready composer | `ready`, cursor (2,13) |
| `codex-small-tile-69x10` | Codex 0.154.0 | ready composer in a 69x10 pane — the board's default tile — with the banner and model line already scrolled off | `ready`, cursor (2,7) |
| `claude-small-tile-69x10` | Claude Code 2.1.270 | ready composer in a 69x10 pane; its compact header still fits | `ready`, cursor (2,7) |
| `open-codex-sign-in` | Open Codex (Codex TUI) | "Finish signing in via your browser" | `transient` `sign-in` |
| `grok-ready` | Grok Build 1.0.25 | ready composer box | `ready`, cursor (6,25) |
| `kimi-folder-trust` | Kimi Code 0.42.0 | "Trust this folder?" dialog, first option `❯ Trust this folder` | `transient` `folder-trust`, affirmative default |
| `kimi-ready` | Kimi Code 0.42.0 | ready composer box, cursor hidden | `ready`, cursor (5,16) |
| `kimi-custom-ready` | bundled Kimi Code 0.42.0 | ready composer box, cursor hidden | `ready`, cursor (5,17) |
| `qwen-ready` | Qwen Code 0.21.12 | ready composer + update banner | `ready`, cursor (2,17) |
| `opencode-ready` | OpenCode 1.18.25 | ready composer rail (alternate screen) | `ready`, cursor (16,15) |
| `cursor-sign-in` | Cursor Agent 2026.06.26 | "Press any key to log in..." | `transient` `sign-in` |

Three further startup screens exist as decoded text only —
`qwen-update-offer.screen.txt`, `claude-external-imports.screen.txt` and
`claude-folder-trust.screen.txt`. The provider-startup probe walked into each of
them on 2026-09-13 and the 0.1.121 detector did not know any of them; the probe
overwrote its own raw recording on its next run, so only the decoded screen
survived. Classifying a startup screen is a text-only decision, so the text is
enough to fix each one in a test.

Gemini CLI is not installed on this machine, so no capture exists for it. Its
recognizer reuses the Qwen Code form (Qwen Code is a Gemini CLI fork) and is
marked UNVERIFIED in the source and in
`docs/orchestrator-terminal-readiness-2026-09-13.md`.

## How they were recorded

Headless, with the same libraries the app uses: `node-pty` spawns the CLI on the
bundled ConPTY, `@xterm/headless` (and, for these fixtures,
`backend/terminalObservation.cjs`) decodes it. Nothing was typed into any pane;
each recording is the screen the CLI painted on its own after launch.

```
node-pty.spawn(<cli exe>, <args>, {
  cols, rows, cwd: <scratch git repo>, name: 'xterm-256color', useConptyDll: true,
  env: <process env minus CLAUDECODE*/CLAUDE_CODE_*/VIBE_TERMINAL_*/LINA_* plus TERM=xterm-256color>,
})
```

To re-record after a CLI upgrade, run `npm run smoke:provider-startup -- --save
<dir>` from `apps/desktop`: the probe launches every kind the way the app does
and writes a `<kind>.bin` / `<kind>.json` pair for each one that reaches its
composer. The pair is named by *kind*, so a ready capture is renamed to
`<kind>-ready.bin` / `<kind>-ready.json` on its way into this folder. Add
`--only <kind,kind>` to re-record just the CLIs that moved, and `--no-type` to
capture the untouched startup screen without spending a model turn — that is
what every `*-ready` recording here is, so `--no-type` is the faithful flag.

`--cols` / `--rows` record the same CLI at another pane size, and `--save-name
<suffix>` writes the pair as `<kind><suffix>.bin` / `.json`. That is how the two
`*-small-tile-69x10` captures were taken:

```
node scripts/qa/provider-startup-probe.cjs --only codex --no-type \
  --cols 69 --rows 10 --save <dir> --save-name -small-tile-69x10
```

A recording made at one width cannot be replayed at another to stand in for it:
the CLI's own cursor addressing is width-dependent, so replaying the 100-column
`codex-ready` stream through a 69-column decoder produces a screen no terminal
ever painted. A pane size that matters gets its own recording.

`kimi-ready` (stock 0.42.0, `~/.kimi-code/bin/kimi.exe`) and `kimi-custom-ready`
(the vendored 0.42.0 fork bundle) were re-recorded on 2026-09-13 after the
vendored bundle moved 0.29.0 → 0.42.0. 0.42 needs no recognizer change: the
welcome box and the ruled composer keep the shape 0.27/0.29 painted, the banner
is three rows shorter (no update-available notice, no web-UI tip), so only the
recorded cursor rows moved. `kimi-custom-ready` opens with the vendored
launcher's own `note: no api.txt …` line, which is the wrapper telling the user
the shared `~/.kimi-code` providers apply.
