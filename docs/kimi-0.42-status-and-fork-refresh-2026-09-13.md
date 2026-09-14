# Kimi 0.42: status hooks, session discovery, and the vendored fork (2026-09-13)

Stock `kimi` panes had stopped reporting WAITING/WORKING/DONE, and session
discovery silently lost every session Kimi Code 0.42 had written. Both were
repaired against Kimi Code CLI 0.42.0 (`C:\Users\ahmed\.kimi-code\bin\kimi.exe`),
and the vendored `kimi-custom` fork was refreshed to the same version.

## The status defect: 264 orphaned hook blocks

Kimi has no per-invocation settings flag and no project-level config, so the app
merges its hook blocks into the one file Kimi reads: `config.toml` in
`$KIMI_CODE_HOME` (default `~/.kimi-code`). Each block was claimed by a
`# vibeterminal-kimi-notify` comment above it, and `stripKimiHooks` removed only
marker-tagged blocks.

**Kimi's own config writer round-trips the file and drops comments.** The first
time the user changed any setting, the marker vanished while the blocks it was
meant to claim stayed. Every app launch then appended a fresh set that could
never collect the previous one. The live config had reached **272 `[[hooks]]`
blocks — 8 still marked and 264 unmarked orphans from 18 shim directories, 17 of
them already deleted.** `matchHooks.ts` de-duplicates only identical
`(cwd, command)` pairs, and each orphan carried a distinct run id, so every kimi
hook event fanned out to roughly 270 PowerShell launches against notify programs
that no longer existed. That is why status looked missing.

The strip is now **content-based**: a block is ours when its `command` invokes a
`notify.ps1`/`notify.sh` under an `agent-shims` run directory with one of our
`agent.*` attention types. A small TOML value decoder reads both the literal
(`'…'`) and basic (`"…\"…\""`) string forms, so our blocks are recognised however
the file was last written. Kept lines keep their own terminators, so user hooks
and every other section survive byte-for-byte, and installing is idempotent to
the byte. The marker is still emitted for readability and still recognised as a
secondary rule, but nothing depends on it. The dead kimi-custom-only cleanup path
(`kimiCustomHookFiles`, `cleanupKimiCustomHooks`, the `KIMI_CUSTOM_HOOK_MARKER`
migration strip) was deleted; both launchers share one stock-compatible set in
the shared home.

Live before and after, running the app's own `ensureKimiHooks` against
`~/.kimi-code`:

```
BEFORE  [[hooks]] blocks: 272   shim run dirs referenced: 18   still on disk: 1
AFTER   [[hooks]] blocks: 9     shim run dirs referenced: 1    still on disk: 1
AFTER   second ensure byte-identical: true
```

71,977 → 4,314 bytes, with `default_model`, `[thinking]`, `[services.*]`,
`[providers.*]` and `[models.*]` untouched. `kimi doctor` reports the result
valid.

### The 0.42 hook contract

`[[hooks]]` is a `.strict()` schema with exactly `event`, `matcher`, `command`
and `timeout`; `timeout` is an **integer number of seconds**, 1 to 600 (the qwen
writer beside it uses milliseconds). `event` must be one of twenty names, and
**one** rejected entry drops the whole hooks array with only a warning — an
unknown event silently disables every vibeTerminal kimi hook, not just its own.
`matcher` is a JavaScript RegExp tested against the event's target (the tool name
for the tool events). Commands run through `shell: true`, so cmd.exe on Windows,
and their output is discarded except for `UserPromptSubmit`.

### Hooks verified firing on 0.42

A probe notify program was installed through the same merge code and two
headless turns were run from a scratch folder:

```
argv=[agent.running]      hook_event_name=UserPromptSubmit
argv=[agent.completed]    hook_event_name=Stop

argv=[agent.running]      hook_event_name=UserPromptSubmit
argv=[agent.running tool] hook_event_name=PreToolUse
argv=[agent.running tool] hook_event_name=PostToolUse
argv=[agent.completed]    hook_event_name=Stop
```

The config was then restored to the cleaned nine-block set, not to the polluted
backup.

### The delegation bracket

Kimi 0.42 exposes `SubagentStart`/`SubagentStop`, but they are **not 1:1**.
`mirrorAgentRun` fires `SubagentStart` before awaiting the child (and only when
the task carries a prompt, `mirrorAgentRun.ts:169`), while the sole
`SubagentStop` producer `notifyAgentTaskStopped` is called from the success
branch alone (`:192`); the `catch` rethrows without it. Because an open bracket
suppresses the pane's own turn end, a leaked "started" is worse than a missed
one, so the native events are not used.

Tool events close reliably instead: an abort or a throw inside a tool is turned
into an `isError` result rather than skipping the hook
(`toolExecutorService.ts:502-548`), so it arrives as `PostToolUseFailure`
instead of `PostToolUse` (`agentExternalHooksService.ts:321-336`). The bracket
is therefore `PreToolUse` / `PostToolUse` / `PostToolUseFailure`, which closes on
success, failure and interruption alike.

The matcher must name **every** delegating tool whose call awaits its children,
because a swarm member is itself a subagent that fires the session-level `Stop`
hook: an unbracketed swarm would settle the pane "done" on its first member. The
four `mirrorAgentRun` call sites were audited:

| Tool | Site | Awaits its children? |
| --- | --- | --- |
| `Agent` | `agent/tools/agent/agentTool.ts:332` | Yes on the foreground path; the `run_in_background` return at `:512` and a mid-run user detach at `:519` do not |
| `AgentSwarm` | `features/swarm/session/sessionSwarmService.ts:191` | Yes — every task is `runInBackground:false` (`agentSwarmTool.ts:185`), `runSwarm` awaits `swarmService.run` (`:203`), and `AgentRunBatch.run` resolves only once every attempt has finished (`session/agentRunBatch.ts:149-172`) |
| `TowerSpawn` | `features/tower/tools/spawn/spawnTool.ts:333` | **No** — `runInBackground:true` (`:325`), the handle is returned unawaited (`:341-347`), the tool only does `void handle.completion` (`:200`, `:206`) and its own output says the run is detached (`:273`). It is also absent from the claude-code profile's tool list, which exposes only `TowerStatus`/`TowerTeardown` (`profile/claude-code/profiles.ts:47-48`) |
| session init | `features/sessionInit/sessionInitService.ts:81` | Not a tool call — nothing to bracket |

The installed matcher is therefore `^(?:Agent|AgentSwarm)$` on all three bracket
entries. `TowerSpawn` and a background `Agent` are deliberately uncovered: a
detached run has no bracket to close, and those children depend on the native
task metadata observer instead.

## Discovery brought to the 0.42 layout

0.42 stores sessions at
`$KIMI_CODE_HOME/sessions/<workspaceId>/<sessionId>/state.json`, indexed by
`session_index.jsonl` (`{ sessionId, sessionDir, workDir }`, no titles). Two
`state.json` shapes coexist on a real machine and both are resumable:

- **0.42**: `{ id, version: 2, cwd, createdAt/updatedAt as epoch MILLISECONDS, archived, lastPrompt, title, titleKind, isCustomTitle }`
- **pre-0.42**: `{ workDir, createdAt/updatedAt as ISO strings, title, isCustomTitle, lastPrompt }`

The reader parsed ISO strings only, so every 0.42 session came back at
`createdAt: 0, updatedAt: 0` — dropped entirely under an `after` cutoff, and with
picker recency flattened to index order. The timestamp parser now accepts finite
numbers as well as ISO strings (matching kimi's own `parseTime`), the launch
folder is read from `cwd` → `workDir` → `custom.cwd` (kimi's `recoverCwd` order),
`titleKind` maps to the ref's title source (`custom` → named, `generated` →
generated, `replaceable` → preview), `archived` sessions are hidden from the
picker as kimi's own session queries hide them while `confirmKimiThread` stays
conservative and still reports them found, and child sessions
(`custom.parent_session_id` / `custom.child_session_kind === 'child'`) are never
offered as root threads.

Baseline against the same 0.42 session, before and after:

```
BEFORE  findLatestKimiThread: {..., "createdAt": 0, "updatedAt": 0}
BEFORE  with after cutoff   : null
AFTER   findLatestKimiThread: {..., "createdAt": 1789300800000, "updatedAt": 1789300800000}
AFTER   with after cutoff   : {...}
```

Live listing for `C:/Users/ahmed/Documents/vibeTerminal` returns 32 real sessions
newest-first with their titles, `confirmKimiThread` confirms the latest
(`rootVerified: true`) and reports an unknown id missing; a workspace holding
0.42-format state files returns 23 sessions whose newest `updatedAt`
(`2026-09-14T01:35:38.340Z`) matches `1789349738340` on disk. Resume is
`kimi --session <id>` (`frontend/sessionLaunch.ts`), confirmed by
`kimi --help`: `-S, --session [id]`.

## Vendored fork refreshed to 0.42.0

Done alongside this work:

- `apps/desktop/vendor/kimi-custom` moved **0.29.0 → 0.42.0** from
  `C:\Users\ahmed\Documents\kimi\kimi-code` (upstream 0.42.0 plus two harness
  commits, claude-code profile default, coder/explore/plan subagents).
- `dist/search-worker.mjs` is newly vendored.
- The fork's `apps/kimi-code/tsdown.config.ts` now force-bundles `ws` and
  `qrcode` (`deps.alwaysBundle`); the native bindings `node-pty` and
  `@mariozechner/clipboard` stay external and guarded, so
  `node dist/main.mjs --version` runs standalone.
- `native/` holds the pi-tui console-mode prebuilds. `dist-web/` is deliberately
  **not** vendored (43 MB, used only by `kimi web`).
- Launchers are unchanged: `api.txt` optional, `chcp 65001`, CRLF, no
  `KIMI_PROFILE`.
- The `kimi-ready` and `kimi-custom-ready` startup fixtures were re-recorded on
  0.42.0 (cursor at (5,16) and (5,17)); no recognizer change was needed. The
  provider-startup probe `--only kimi,kimi-custom --no-type` reports both ready
  in 4.3 s.

Details in [vendor material](vendor.md) and the provider-startup fixtures README.

The claude-code profile is the live default of the vendored bundle: one headless
turn, `node apps/desktop/vendor/kimi-custom/dist/main.mjs -p "reply with the
single word: ok"` from a scratch folder, answered "ok" and created
`session_64d9cd65-98fc-455b-860f-f7752ada37d0` under
`wd_profile-check_6a5955c242e5`. Its `agents/main/wire.jsonl` `profile.bind`
record shows profileName `agent` (the last-wins upsert keeps the stock name),
modelAlias `kimi-code/kimi-for-coding`, and a 14,348-character systemPrompt
beginning "You are an interactive agent that helps users with software
engineering tasks." — the fork's `profile/claude-code/system.md` — with zero
occurrences of the stock "You are Kimi Code CLI" prompt. The shared
`~/.kimi-code` login served it with no `api.txt` present.

## Verification

```
cd apps/desktop
node --test scripts/backend/agent-telemetry-kimi-hooks.test.cjs
npm run smoke:backend:agent-telemetry
npm run smoke:backend:kimi-discovery
npm run smoke:backend:kimi-custom-discovery
node --test scripts/backend/kimi-task-observer.test.cjs
npm run test:terminal-status
npm run smoke:provider-startup -- --only kimi,kimi-custom --no-type
```

`test:terminal-status` is 118/118. The hook test asserts that orphan blocks are
collected while user hooks and other sections survive verbatim, that every
installed block stays inside the four-field strict schema with an integer
seconds timeout and an event from the twenty-name enum, that the bracket matcher
covers every awaiting delegation tool and nothing else, that a second ensure
changes no byte, and that a config the app created is removed again on cleanup.

## Not verified

- End-to-end status in a **packaged** build. The hook evidence in the sections
  above is from headless `kimi -p` runs; the dev-Electron pane evidence is in
  "Live re-verification" at the end of this file.
- `PermissionRequest`, `StopFailure` and the subagent bracket firing live: the
  probe turns never hit an approval, a failure, or an `Agent`/`AgentSwarm`
  delegation. The bracket's coverage is established from the fork source, not
  from an observed swarm.
- Resuming an `archived` session. No archived sessions exist on this machine, so
  whether `--session` accepts one is unknown; `confirmKimiThread` stays
  conservative for that reason.

## In-app verification and the runtime defects it exposed

Everything above was established from headless `kimi -p` runs. An instrumented
run of a `kimi` pane and a `kimi-custom` pane inside the Electron app, in one
folder, confirmed the hook transport end to end and found the pill wrong in both
panes anyway. Every notify POST was accepted (HTTP 204) for both `agent.running`
and `agent.completed`. The receiver payload for a root `UserPromptSubmit` is

```
{"type":"agent.running","sessionId":"<pane id>","launchNonce":"…","timestamp":<ms>,
 "invocationId":"…","cwd":"<pane cwd>","providerThreadId":"session_<uuid>"}
```

and `Stop` is the same with `"type":"agent.completed"`. There is no
`rootVerified`, no `providerTurnId` (kimi's Stop JSON carries `session_id`,
`cwd`, `client_type`, `session_title` and `stop_hook_active` only — no turn id,
which is why kimi's completion is coarse by construction) and no `agent_id` on
root hooks. The three defects were all in the runtime, not in the hooks.

### The first prompt's identity was parked, then replayed after the turn ended

On the stock pane the running POST landed 0.33 s after the submit and the pane
stayed "awaiting activity"; the completed POST landed at 2.85 s and "response
available" appeared 259 ms later. "working" was never painted at all.

A hint without `rootVerified: true` is treated as unproven in
`backend/terminalRuntime.cjs`: the id goes into `record.identityHints`, the event
into `record.pendingEvents`, `observation` becomes `provisional`, and the ingest
returns. Binding then happened only on the 8 s refresh timer, which confirms the
hint and calls `replayPending()` — replaying `agent-running` and
`agent-attention completed` back to back, so the running state existed for
microseconds. Nothing was lost; it was simply never visible.

The rule that turns a hint into a root conversation is now one helper,
`bindFromHint(record, hintId, transcriptPath, confirmed)`: confirmed, root
verified, no parent, not owned by another pane, then bind. The refresh timer and
a new inline path both call it, so a hint cannot bind one way now and another way
on the tick. The inline path needs its answer inside the hook's own tick, which
the discovery host cannot give — it replies over IPC — so `createTerminalRuntime`
takes a `confirmSync` and `backend/main.cjs` wires it to `confirmKimiThread` /
`confirmKimiCustomThread` read directly in the main process; kimi's store confirm
is one `session_index.jsonl` read plus one `state.json`, and every other provider
returns nothing and stays on the timer. It is attempted once per distinct hint; a
store that has not written the session yet parks exactly as before. That fallback
is rarely needed, because kimi writes `state.json` and the index row when the
session is created, not at the first prompt: of the 217 sessions in this
machine's `~/.kimi-code`, 95 have no `lastPrompt` and all 95 are indexed with a
readable `state.json`.

### Ownership was keyed on the provider label, not on the store

The `kimi-custom` pane was bound to the *kimi* pane's session id. Both of its own
hook events therefore took the child branch: "working | 1 child", then "awaiting
activity | 1 child" with `turnState` `unknown` and `pendingInput` `submit`
permanently.

`owned()`, and the `excluded` and `competing` sets in the refresh scan, compared
`record.snapshot.provider`. `kimi` and `kimi-custom` are distinct provider strings
over one store (`kimiCustomHome()` returns `kimiHome()`), so the sibling's session
was not excluded from the kimi-custom pane's list scan and was its single unowned
candidate. Once mis-bound, every event carrying the pane's real session id had
`providerThreadId !== conversation.id` → `isChild()` → `observeChild()`, and a
coarse completion can never remove a child.

All three comparisons now fold the provider through `storeFamily()` in
`shared/chatIdentity.cjs`, which already held the `kimi-custom` → `kimi` fold for
chat identity keys; there is one definition, not two tables. Claude's custom
profile is deliberately absent from it: that profile scans a different home
(`VIBE_CLAUDE_CUSTOM_HOME`) and the runtime already separates the two by
`record.claudeHome`. No other provider pair aliases a home.

A fourth defect surfaced while testing this one. `replayPending()` replayed every
parked event, including a hint naming a *sibling pane's* root — which, after this
pane bound its own root, filed the sibling's turn here as phantom child work that
coarse completion could never clear. Replay now skips events whose id another
open pane in the same store family owns. A hint no other pane owns still replays:
that is how a subagent is observed.

### The quit cleanup was unreachable

Hook blocks stayed merged into `~/.kimi-code/config.toml` and the telemetry shim
run directory survived every quit. `agentTelemetry.cleanup()` had exactly one
caller: the `window-all-closed` handler in `backend/main.cjs`. Electron emits that
event only when the last window closes on its own. Lina's own
`mainWindow.on('close')` preventDefaults and calls `app.quit()` after
`prepareChatShutdown()`, and a programmatic quit runs `before-quit` → `will-quit`
→ `quit` without ever emitting `window-all-closed`. So on a normal quit the
cleanup never ran.

The teardown body is now one idempotent `shutdownRuntimeHosts()` — each step
wrapped so a throwing step cannot stop the others or block the quit — called from
both `window-all-closed` and a new `will-quit`. The latch is released in
`createMainWindow()`, so a macOS dock re-activation that rebuilds the hosts can
still tear them down at the real quit. The existing `before-quit` guards are
untouched.

### Verification

```
cd apps/desktop
node --test scripts/backend/kimi-runtime-binding.test.cjs
npm run test:terminal-status
node --test scripts/backend/native-status-reconciliation.test.cjs scripts/backend/kimi-task-observer.test.cjs
npm run smoke:frontend:app-runtime
```

`scripts/backend/kimi-runtime-binding.test.cjs` builds a real 0.42 store under a
temporary `KIMI_CODE_HOME` and asserts, for both providers, that the running
payload above binds and reaches `working` with no timer tick and nothing parked,
that the coarse Stop reaches `response available`, that an unwritten session still
parks, that same-folder kimi and kimi-custom panes exclude each other's session
from both the list scan and the inline path without inventing a child, and that
the quit teardown runs once and survives a step that throws. The `working` and
`response available` strings come from `frontend/terminalRuntime.ts`'s own
`runtimeStatusLabel`, not from a copy.

### Live re-verification

Both panes were re-run in the Electron app after the fix, on an isolated
`userData`, driven over CDP with the DOM sampled every 200 ms, two real model
turns. Times are from the submit of the prompt.

- **Stock kimi pane**, prompt submitted 05:06:30.943 UTC. `awaiting activity` →
  **`working` first seen at +697 ms** → **`response available` at +3417 ms** (the
  Stop hook). End-of-turn runtime: `turnState` `"response"`, `observation`
  `"provisional"`, `pendingInput` `null`, `children` `0`, `attention` `null`,
  `conversation.id` `session_49d75d96-3a99-44a2-a50b-1b6be35f9d3a` (provider
  `kimi`).
- **Kimi + CC pane**, prompt submitted 05:06:52.188. **`working` first seen at
  +690 ms** → **`response available` at +6651 ms**. `children` was `0` for the
  whole turn — the pill never read `| N child`. `conversation.id`
  `session_cec50390-61a8-47a3-ba02-c1507592c7db` (provider `kimi-custom`). The
  two panes' ids differ: the cross-pane collision and the phantom child are gone.

Before the fix the same two panes sat at "awaiting activity" until Stop, and the
kimi-custom pane sat at "working | 1 child" and then "awaiting activity | 1
child" permanently.

Quit cleanup, read out of `config.toml` at each stage:

| Stage | vibeterminal blocks |
| --- | --- |
| Both panes running | 9, pointing at this run's `agent-shims` dir |
| After a plain window close | **0** |
| Relaunch with one kimi pane | 9, at the new run dir |
| After quit | **0** |

The close removed 57 lines and added none; the user's own non-hook config is
byte-identical across the cycle (4,359 → 1,705 bytes), and the run's
`agent-shims/<run>` directory is gone.

**Unchanged by design.** A finished kimi pane settles at "response available",
not "done", because kimi is `finalCompletion: "coarse"` — its Stop hook carries
no turn id (`session_id`, `cwd`, `client_type`, `session_title`,
`stop_hook_active` only), so nothing proves the model turn itself ended rather
than an intermediate response. That is the same end state Claude and Qwen reach,
and it means a finished kimi pane counts in neither the working nor the done
sidebar bucket. Changing it would require a turn identity kimi does not emit.
