# Codex cursor flicker investigation (2026-09-11)

Investigation, then repair. Fix option 1 (bundled ConPTY) is implemented and
smoke-verified — see [Repair (2026-09-11)](#repair-2026-09-11) at the end. Read
this before touching `backend/ptyHost.cjs`, `frontend/terminalCursor.ts` or
`frontend/terminalOutput.ts` for Codex panes.

## Summary

The flickering cursor in Codex panes is a cursor **position jump**, not a
blink, and it is produced by the pseudo-console layer Lina spawns terminals
through, not by xterm or by Lina's cursor handler.

Two things combine:

1. Codex CLI 0.152 and later re-applies the cursor style on every redraw
   frame: it moves the cursor to a "repair anchor" cell near the top of its
   live viewport, emits `CSI 0 SP q`, redraws that cell, and moves the cursor
   back to the composer. Older Codex (0.144) set the style once at the start
   of the frame and never parked the cursor.
2. Lina spawns PTYs through node-pty with the default `useConptyDll: false`,
   so Codex output is re-rendered by the **inbox conhost** (10.0.26100.1 on
   this machine). That conhost flushes a paint the moment it meets the
   cursor-style sequence, with the cursor **shown at the anchor**, closes the
   synchronized-update bracket, and only ~15 ms later paints the move back to
   the composer in a separate, unbracketed write. A current OpenConsole
   (1.23 bundled in node-pty, 1.24 in Windows Terminal) keeps the whole
   sequence inside one bracket and never shows the cursor at the anchor.

Lina's frame coalescer joins everything inside a bracket, so with the inbox
conhost the parked position reaches xterm as its own frame. The jump repeats
on every keystroke and about nine times per second while a turn runs, which
reads as continuous flicker "in the terminal" (anchor row) and "in the input
box" (composer). The normal Codex CLI in Windows Terminal does not flicker
because Windows Terminal hosts it through its own OpenConsole 1.24.

The v0.1.116 cursor handler is installed and working. It fixes cursor
*style* (the default-shape reset) and cannot cover a *position* jump.

## Scope

- Affected: plain `codex` panes running the global npm Codex CLI 0.154.0
  (what the live panes run) and Lina's bundled Codex Web binary, also
  0.154.0; any Codex from 0.152.0 up, as long as Lina spawns through the
  inbox conhost.
- Not affected: the bundled Open Codex binary (0.144.0); Codex in Windows
  Terminal; Codex spawned through node-pty's bundled ConPTY.
- Idle composer with no turn running: Codex 0.154 emits no bytes, so nothing
  flickers. Typing and working turns do.

## Evidence

All captures use the exact global binary the panes run, in a ConPTY of
120x30, with chunk boundaries as node-pty delivered them.

### 1. Same keystroke (`h`), two pseudo-console hosts

Inbox conhost (node-pty default, what Lina uses):

```
+0 ms   \e[?2026h\e[?25l\e[48;2;41;41;41mh\e[K\e[12;1H\e[?25h
+0 ms   \e[0 q
+0 ms   \e[?2026l
+15 ms  \e[?25l\e[m \e[14;4H\e[?25h
```

Hide, draw the glyph in the composer, move to the anchor (row 12 col 1),
**show**, cursor style, end of frame. Fifteen milliseconds later, outside any
bracket: hide, redraw the anchor glyph, move back to the composer (row 14
col 4), show.

node-pty bundled OpenConsole 1.23 (`useConptyDll: true`):

```
+0 ms   \e[?2026h\e[11;4H\e[0m\e[48;2;41;41;41m\e[K\e[11;3Hh\e[39m\e[49m\e[0m\e[9;1H
+0 ms   \e[0 q\e[9;1H \e[39m\e[49m\e[0m\e[11;4H\e[?25h\e[?2026l
```

Anchor move, cursor style, anchor glyph, return to the composer, then the
single show, all inside one bracket. The cursor is never shown at the anchor.

During a working turn the inbox conhost repeats its split every ~110 ms
(status spinner tick): `\e[?2026h\e[?25l\e[22;1H\e[?25h` + `\e[0 q` +
`\e[?2026l`, then 15 ms later `\e[?25l \e[24;3H\e[?25h`. The bundled
OpenConsole emits one bracketed frame per tick with the show at the end.

### 2. Codex 0.144 keystroke, inbox conhost, for comparison

```
+0 ms   \e[?2026h\e[0 q
+0 ms   \e[?25l\e[14;2H\e[K...\e[16;3Hh\e[K...\e[16;4H\e[?25h
+0 ms   \e[?2026l
```

Style reset first, cursor hidden while the diff is drawn, shown once it is
back at the composer. Nothing for the conhost to split.

### 3. Codex source (tag `rust-v0.154.0`, `codex-rs/tui/src`)

- `custom_terminal.rs`, `try_draw_with_size`: after flushing the diff, when a
  cursor position exists it calls `set_cursor_style_with_repair(style)`, then
  `set_cursor_position(position)`, then `show_cursor()`.
- `custom_terminal/cursor.rs`, `set_cursor_style_with_repair`: finds the first
  owned glyph in the viewport buffer, moves the cursor there, queues the
  DECSCUSR, and redraws that glyph, "even on unchanged frames". The comment
  cites JediTerm before 3.56; the repair is not gated on the terminal.
- `bottom_pane/chat_composer.rs`, `cursor_style`: `SteadyBar` only in vim
  insert mode, otherwise `DefaultUserShape` (`CSI 0 SP q`).
- History: commit `da23e131e6`, 2026-08-30, "Repair cursor-style rendering on
  older JediTerm terminals (#41673)". The module is absent at tags 0.144.0,
  0.150.0 and 0.151.0 and present at 0.152.0.

### 4. Renderer replay through Lina's real stack

An offscreen Electron window with xterm 5.5.0's DOM renderer, the real
`terminalOutput.ts` coalescer and `terminalCursor.ts` handler, replaying each
capture at recorded timing and sampling the `.xterm-cursor` element on every
animation frame:

| Capture | Phase | Rendered frames | Cursor absent | Animations | Position transitions |
| --- | --- | --- | --- | --- | --- |
| Inbox conhost | Typing, 11 keys | 189 | 0 | 0 | 22 (park + return per key) |
| Inbox conhost | Working turn, 6 s | 176 | 0 | 0 | 40 (20 park/return pairs) |
| Bundled OpenConsole | Typing, 11 keys | 186 | 0 | 0 | 16 (one cell forward per key, then layout shifts) |
| Bundled OpenConsole | Working turn, 6 s | 171 | 0 | 0 | 5 (layout shifts only) |

With the inbox conhost the cursor alternates between the composer cell and
column 0 of the anchor row. With the bundled OpenConsole it only moves
forward. In every sample the style stayed `bar`, blink stayed `false`, and
every DECSCUSR was the intercepted `0`.

### 5. Host versions on this machine

| Host | Version | Used by |
| --- | --- | --- |
| Inbox `conhost.exe` (system ConPTY) | 10.0.26100.1 | Lina today (node-pty default) |
| node-pty bundled `OpenConsole.exe` + `conpty.dll` | 1.23.2510.08001 | Opt-in via `useConptyDll: true`; already unpacked in the installed app under `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty` |
| Windows Terminal `OpenConsole.exe` | 1.24.2607.10001 | The "normal" Codex CLI |

### 6. Ruled out

- Installed build: `%LOCALAPPDATA%\Programs\vibeTerminal` is 0.1.116 and its
  renderer bundle contains the Codex cursor handler and the
  `codex`/`open-codex`/`codex-web` gate.
- Explicit blinking DECSCUSR from Codex: never emitted; only parameter 0.
- Backend PTY host: no timers, probes, keystroke injection, or repeated
  resizes reach a Codex PTY; `ptyHost.cjs` resize sites are all guarded on a
  size change.
- Renderer: no CSS on `.xterm-cursor`, no theme or option churn, no remount
  on status ticks, focus calls are event driven. The 80 ms coalescer deadline
  never fired: bracketed frames arrived in 2 to 3 chunks within 2 ms.
- `configureCodexCursor` and `scripts/qa/terminal-cursor-smoke.cjs` behave as
  documented; the smoke passes. It only exercises style, not this pattern.

## Fix options (option 1 implemented, see Repair below)

1. Spawn through node-pty's bundled ConPTY: pass `useConptyDll: true` in
   `pty.spawn` in `backend/ptyHost.cjs:351`. This is the change that matches
   the verified good capture. The binaries already ship (see section 5), so
   no packaging change is needed. It changes the host for every pane kind, so
   the existing session-launch, tiled-resize, kimi-custom and Codex smokes
   must be rerun, and the kill and exit path deserves a look: node-pty takes a
   different branch for the DLL host (`windowsPtyAgent.js:137`), and the
   `conpty_console_list_agent` warning that `main.cjs:1080` already filters
   belongs to the non-DLL path. A follow-up could also try Windows Terminal's
   1.24 host, but node-pty only loads its own bundled copy.
2. Renderer mitigation in `frontend/terminalOutput.ts`, if the host must stay
   as is: when a synchronized frame ends with `\e[?25h\e[0 q`, keep holding
   until the next write that ends with `\e[?25h`, or roughly 40 ms. Park and
   return then reach xterm as one write. Cost is up to 15 ms of extra latency
   on those frames. The inbox-conhost bytes in section 1 are the regression
   fixture; extend `terminal-cursor-smoke.cjs` to replay them and assert the
   cursor element never leaves the composer cell.
3. Upstream: Codex could keep the cursor hidden until it is back at its real
   position, or gate the JediTerm repair on a probe. Lower priority since
   current console hosts already render the sequence correctly.

## Reproduction notes and boundaries

- Probe: spawn the Codex binary under node-pty with a scratch `CODEX_HOME`,
  a stub provider from `backend/openCodexAdapter.cjs`, record every chunk
  with timestamps, then replay through `@xterm/headless` (await each write;
  the write API is asynchronous) and through the offscreen Electron
  instrument. Toggle `useConptyDll` on the spawn to compare hosts.
- Codex refuses to create helper binaries when `CODEX_HOME` is under `%TEMP%`;
  use `apps/desktop/.tmp` (gitignored) and remove it afterwards.
- On a fresh home Codex shows a Windows sandbox setup screen. Option 1
  triggers a UAC elevation prompt; never script Enter on that screen. The
  non-admin option completes in 20 to 25 s without elevation. Bypass flags
  and a copied full-access config were not used.
- The live app was not inspected: its `DevToolsActivePort` file is stale from
  July and the port is closed. Findings come from the same binary, the same
  console host, the same renderer modules and the same xterm version the
  installed app uses. Windows Terminal's own host was not captured directly;
  the claim about it rests on its newer OpenConsole version and the user's
  report that the normal CLI does not flicker.

## Repair (2026-09-11)

Fix option 1 is implemented: every Windows pane now spawns through node-pty's
bundled ConPTY host.

### What changed

- `apps/desktop/backend/ptyHostOptions.cjs` (new) - `windowsPtyHostOptions(env)`
  returns `{}` off Windows and `{ useConptyDll: env.LINA_CONPTY_HOST !== "system" }`
  on win32. `describePtyHost(options)` names the selected host
  (`openconsole` / `conhost` / `native`) for logging. `spawnPty` performs the
  spawn and, if the bundled host cannot start on a given Windows build, retries
  once on the inbox conhost and returns `{ terminal, host, fallbackError }`, so
  a pane always opens instead of failing to launch.
- `apps/desktop/backend/ptyHost.cjs` - `createSession` computes the options
  once, spawns through `spawnPty` at the single production spawn site, records
  the host actually used in the existing `create` debug event, and logs one
  `host-fallback` debug event when the fallback fired. No renderer-visible
  protocol or event changed; shell file, shell args, cwd and env are untouched.
- `apps/desktop/scripts/backend/pty-host-options.test.cjs` (new) and
  `apps/desktop/scripts/backend/conpty-host-smoke.cjs` (new), both behind the
  `smoke:backend:conpty-host` script in `apps/desktop/package.json`.
- `docs/backend.md` - `backend/ptyHost.cjs` bullet extended; new
  `backend/ptyHostOptions.cjs` bullet.

No packaging change was needed: `asarUnpack` already covers
`node_modules/node-pty/**`, so `prebuilds/win32-x64/conpty/OpenConsole.exe` and
`conpty.dll` are already unpacked in the installed app.

### Escape hatch

`LINA_CONPTY_HOST=system` puts panes back on the inbox conhost for diagnosis.
Nothing else reads the variable; the value is compared exactly, so any other
value (or none) keeps the bundled host. It is the *manual* override — separately
and automatically, `spawnPty` falls back to the inbox conhost for that one pane
if the bundled host throws on spawn (logged as `host-fallback`), so a Windows
build that cannot load `conpty.dll`/OpenConsole degrades instead of failing to
open panes. `main.cjs`'s
`conpty_console_list_agent.js` / `AttachConsole failed` stderr filter is left in
place — it belongs to the inbox-conhost kill path the escape hatch restores.

### Acceptance evidence

`npm run smoke:backend:conpty-host` drives the real `backend/ptyHost.cjs` child
over its JSON-line protocol and reads the live process tree with
`Get-CimInstance Win32_Process`. Pane console hosts are identified by the
`--headless ... --server <handle>` command line node-pty gives them; the
ptyHost's own console (`conhost.exe 0x4`) is not one. Two consecutive runs:

```
conpty-host smoke: PASS
  a. default pane host   OpenConsole.exe pid=49260 (conhost.exe pane hosts: 0)
  b. round-trip          RT:OK after 1620ms
  c. natural exit        exitCode=0, console hosts left behind: 0
  d. kill                shell pid 20116 and tagged child gone, console hosts left behind: 0
  e. LINA_CONPTY_HOST=system  conhost.exe pid=59484

conpty-host smoke: PASS
  a. default pane host   OpenConsole.exe pid=28332 (conhost.exe pane hosts: 0)
  b. round-trip          RT:OK after 1623ms
  c. natural exit        exitCode=0, console hosts left behind: 0
  d. kill                shell pid 60712 and tagged child gone, console hosts left behind: 0
  e. LINA_CONPTY_HOST=system  conhost.exe pid=56420
```

The pane host's command line is asserted to come from
`node_modules/node-pty`, so the assertion is about the bundled copy, not any
OpenConsole that happens to be installed.

Everything else rerun on the switched host, all passing:

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run smoke:backend:conpty-host` (×2) | pass |
| `npm run smoke:backend:terminal-runtime` | pass (31/31) |
| `npm run smoke:frontend:session-launch` | pass |
| `npm run smoke:frontend:tiled-resize` | pass |
| `npm run smoke:frontend:terminal-output` | pass |
| `node scripts/qa/terminal-cursor-smoke.cjs` | pass |
| `npm run smoke:electron:terminal-board` | pass |
| `npm run smoke:electron:terminal-scroll` | pass |
| `npm run smoke:backend:agent-telemetry` | pass |
| `node --test terminal-observation-real / terminal-observation / orchestrator-terminal-input` | pass (51/51) |
| `npm run test:codex-web` | pass (77/77) |
| `npm run test:open-codex` | pass (16/16) |
| `npm run test:performance` | pass (29/29) |

### The conhost leak this also fixes

Measured 2026-09-11 on the installed 0.1.116 while the user was working in it:
the live ptyHost process (`LinaTerminal.exe ... app.asar.unpacked\backend\ptyHost.cjs`,
pid 26804, started 14:15) had **37 headless `conhost.exe` children against 14
live `powershell.exe` panes** — 23 orphaned console hosts accumulated in one
session, 26.7 MB of working set across the 37. That is node-pty issue #965: the
inbox conhost survives its pane's natural exit for the life of the host process.
The smoke's natural-exit assertion (c) is the regression lock for it; with the
bundled host the count returns to zero immediately, and the escape-hatch probe
reproduces the leaking behavior on demand.

### Behavior differences worth knowing

- **Kill exit code.** `terminal.kill()` on a foreground child reports exit code
  `1` with the bundled host and `-1073741510` (`STATUS_CONTROL_C_EXIT`) with the
  inbox conhost. The renderer treats any non-zero code as "failed", so the pane
  state is unchanged.
- **No `exit` event on explicit kill.** The `kill` message disposes the
  session's listeners before node-pty's `onExit` fires, so the host emits no
  `exit` event for an operator kill. That is pre-existing behavior, verified
  identical in both host modes; the smoke pins it, and proves the kill instead
  by asserting the pane's shell pid and its tagged foreground child are gone.
- **The filtered stderr goes quiet.** Killing a pane on the inbox conhost prints
  the `conpty_console_list_agent.js` / `AttachConsole failed` crash that
  `main.cjs` filters out. The bundled host takes a different kill branch and
  never prints it. The filter stays in place because the escape hatch restores
  that path.

### Remaining boundaries

- The packaged build was not rebuilt or reinstalled in this pass. The change is
  verified against the real `backend/ptyHost.cjs` from source; the installed
  app keeps the inbox host until the next release.
- Windows Terminal's own OpenConsole 1.24 was still not captured directly.
  node-pty only loads its own bundled 1.23, which is what shipped here.
- The flicker itself was not re-measured end to end in the live app (its
  DevTools port is still closed). The evidence chain is the section 1/4
  captures: the bundled host produces the single-bracket byte stream, and the
  renderer replay of that stream shows no park/return transitions.
