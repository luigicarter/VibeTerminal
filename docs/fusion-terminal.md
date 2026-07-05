# Terminal Fusion

> **Per-role families (2026-07-04):** the planner and executor each pick a
> FAMILY — Claude (claude CLI) or Codex (codex app-server) — then a model
> inside it, through an Open Fusion-style two-stage picker (`/planner-model`,
> `/executor-model`, or clicking either model in the composer meta row; no
> provider-connect/API-key flows — both families ride existing subscriptions).
> All four quadrants run: claude+codex (classic), claude+claude,
> codex+codex, codex+claude. Settings are per-role
> (`plannerFamily/plannerModel/plannerEffort`,
> `executorFamily/executorModel/executorEffort`) with legacy
> `model/claudeEffort/codexModel/codexEffort` migration everywhere
> (`normalizeFusionRoleSettings` in `frontend/components/fusionSlashMenu.ts`
> is the single funnel). Planner changes restart the pane (same-family
> restarts resume the thread; cross-family starts fresh, transcript kept);
> executor changes apply live via `fusion-settings.json` (now carrying
> `executorFamily/executorModel/executorEffort` + legacy mirrors). The codex
> PLANNER runs `codex app-server` per pane with `thread/start
> {sandbox:"read-only", approvalPolicy:"never", developerInstructions:<the
> architect prompt>, config.mcp_servers["fusion-codex"]:<the same adapter>}`
> — the read-only planner lock stays HARD (sandbox-enforced; live-verified
> 2026-07-03 on codex 0.142.5 incl. per-thread MCP hosting and the
> `mcpServer/elicitation/request` auto-accept the brain host must answer).
> The claude EXECUTOR is a persistent headless `claude` child inside
> fusion-adapter.cjs (bypassPermissions — parity with the codex executor's
> dangerFullAccess/never), reusing the host's exported arg builder + stream
> normalizer; goals are emulated adapter-locally for it, and the codex_*
> bridge tool names stay unchanged regardless of engine (the system prompt
> says so explicitly).

> **Status: implemented (M2 engine + M3 headless chat UI + M4 embedded per-pane Codex).**
> A Fusion pane is a custom **Claude-Code-style chat UI**: Claude runs HEADLESS
> (stream-json) as **Opus or Sonnet 5** the read-only orchestrator/architect and delegates
> ALL code writing, execution, and verification to Codex (**GPT-5.5**) via a per-pane MCP
> adapter; exceptional decisions can route back to Opus. Each
> Fusion terminal spawns its **OWN embedded** Codex `app-server` over **stdio**
> (the bundled binary, `vendor/codex-bin/<plat>` → `resources/` via
> `extraResources`; `resolveCodexBin()` permits a PATH fallback only in dev) — no
> shared server, no ws. Packaged builds fail closed if the embedded Codex binary
> is missing. The xterm presentation is retired for Fusion (other panes keep xterm).
> Headless multi-turn uses a long-lived `--input-format stream-json` process
> (M3.1 spike). Verified: typecheck/build + smoke suite (incl. the embedded
> binary booting `app-server`, + `fusion-chat-parse`) + clean boot. Remaining: a
> live turn needs `claude login` + `codex login`; per-platform binaries +
> code-signing for release. (2026-07-04: the transcript is no longer ephemeral
> across resumes — `/resume` opens a saved-chat picker for the folder, newest
> first with generated titles, and the host rehydrates the picked conversation
> into the pane from the claude project JSONL / codex rollout; see
> docs/backend.md and docs/frontend.md.)
>
> **Settings layer rewrite (2026-07-02, hardened 2026-07-03):** model/effort
> selection is catalog-backed and validated, mirroring Open Fusion's native
> feel. The pure menu/catalog logic lives in
> `frontend/components/fusionSlashMenu.ts` (extracted so the smoke executes
> real behavior). Curated model catalogs (Claude: Opus 4.8 / Sonnet 4.5 /
> fable aliases + validated `claude-*` ids; Codex: ids read from the shipped
> 0.142 binary + custom escape hatch); **per-engine effort enums** — planning
> uses the `claude --effort` enum (low..max), execution uses codex's own
> (minimal..ultra — codex has NO "max"; legacy "max" coerces to "xhigh" at
> every layer). The claude effort NEVER backfills the codex effort (main's old
> `payload.codexEffort ?? payload.effort` fallback silently ran every
> delegation at the claude level while the UI said "Execution Auto").
> Selection semantics (the 2026-07-03 pass — each of these was a live "my
> pick didn't stick" bug): the `/claude`/`/codex` submenus lead with the
> CURRENT model marked `· current`, so Enter on the bare command is a no-op
> instead of committing the default at index 0; typing after `/claude`
> FILTERS the submenu (it used to close it) and an unmatched-but-launchable
> id gets an explicit `Use '<id>'` row; `/opus effort <x>` and the
> balanced/deep/max speed presets are effort-only (they used to force the
> model back to Opus). The old downgrade speed preset is now `quick`: it
> switches the planner to the family's lighter model and drops effort to low.
> `/fast` is reserved for real fast serving (same model and same effort,
> faster token serving at higher cost) and toggles independent
> `plannerFast`/`executorFast` flags; `/fast planner`, `/fast executor`,
> `/fast on`, and `/fast off` are live settings changes. Esc closes the menu
> but keeps the typed input (second Esc clears);
> Shift+Tab never flips Plan/Auto while a slash command is being typed; Tab
> can't blur the composer mid-command; hover-highlight arms on real mouse
> movement only. Unknown planning models are refused before anything
> restarts; unknown `/speed` values error instead of being reinterpreted as a
> model. Errors that arrive as complete (non-streamed) assistant messages —
> e.g. a model the account can't use — surface as turn errors instead of
> silently ending the turn with no output (`result.is_error` is forwarded
> too). Model/effort picks persist app-wide: new Fusion panes start from the
> last-used configuration (localStorage `vibe-terminal:last-fusion-settings`)
> until changed. Settings restarts keep the visible transcript and append the
> notice (same Claude thread resumes). Locked by
> `scripts/frontend/fusion-settings-smoke.cjs`.

Goal: a **Fusion** terminal that fuses the *capabilities* of two coding agents
behind one surface — Claude (Opus or Sonnet 5) as the read-only orchestrator/architect/designer and
long-horizon coding controller using Codex native goals, and Codex (GPT-5.5) as
the sole code writer, executor, tester, bug reviewer, and completion verifier — so the user talks to
one terminal and the right model handles each sub-task. Think "OpenRouter, but for **complementary
specialists** rather than interchangeable models": the router doesn't pick one
engine for the whole prompt, it **decomposes** the task and routes sub-tasks by
specialty. Picture/image generation and web browser control are Codex-owned
execution tasks in this split: Claude decides what is needed, then delegates the
actual image or browser work through Codex. The routing intelligence is Claude
itself (an LLM that decides when to delegate), not a static rule table.

## Roles and completion authority

The two models have hard, enforced scopes. Claude is launched read-only: `Read`/`Grep`/`Glob` plus the Codex bridge tools on the restricted built-in `--tools` surface with a strict per-pane MCP config. Every file-edit tool is hard-blocked via `--disallowedTools` (`Bash` plus `Edit`/`MultiEdit`/`Write`/`NotebookEdit` — see `FUSION_CLAUDE_EDIT_DENY_TOOLS` in `main.cjs`), so ALL code writing in every layer — frontend included — is structurally forced through `codex_implement`, read-only command/environment checks go through `codex_investigate`, and tests, builds, debug runs, screenshots, browser control, and image generation are Codex-owned. Codex remains the hard verifier for bugs and goal completion. Claude still owns UI/design *decisions*: it reads the relevant files, decides exactly what should change, and hands Codex the specification (2026-07-03: the interim direct-`Edit`/`Write`-for-UI experiment was reverted at the user's direction — the planner must not write code).

The architect prompt also carries concurrent-edits guidance (locked by `fusion-launch-smoke`): file drift that is not explained by Claude's own Codex delegation may mean another agent pane or tool is editing the same checkout — Claude should re-read, hold the delegation, and surface the foreign drift to the user instead of silently letting Codex retry over it. The renderer's shared-folder chip (`frontend/cwdConflicts.ts`) shows the human the same overlap.

| Opus 4.8 (Claude - orchestrator/architect/designer) | Codex GPT-5.5 (implementer/reviewer/verifier) |
|---|---|
| Architecture decisions | Editing files |
| Debugging strategy | Running tests |
| Threat-modeling a design | Fixing compile/runtime errors |
| Reviewing a Codex plan before it touches a large repo | Refactors |
| "What are we missing?" analysis | Repo navigation |
| Tradeoff reasoning | Implementing from an approved plan |
| UI/design direction (specify the change; Read/Grep/Glob review) | Iterative debugging loops |
| Guiding Codex with constraints, UI intent, debugging direction, and corrections | Following Claude guidance while independently checking the result |
| Human-facing override decisions | Bug review and goal-completion verification |
| Deciding when image/browser work is needed | Picture/image generation and browser control |

Codex's structured verifier verdict gates completion. Claude can continue, ask
the human, or explicitly override, but it should not present the task as done
when Codex reports `goalReached:false`, blocking bugs, missing requirements, or
`nextAction:"continue"`. Claude guidance is direction and context for Codex,
not a substitute for Codex's independent verifier verdict.

**The loop:** Opus plans/designs → Codex implements + runs tests + fixes → produces
a diff and structured verifier verdict → if Codex says not done, Opus continues
or redelegates with more guidance → Codex fixes and verifies again. Claude reviews diffs with Read/Grep/Glob against its specification; any adjustment it wants goes back through `codex_implement`.

**Checkpointed delegation** (locked by `fusion-launch-smoke` +
`fusion-adapter-smoke`): multi-stage work is split into 2–5 independently
verifiable milestones — ONE `codex_implement` call per milestone, and Claude
must review the returned summary/files/verdict and Read the changed files
against its spec BEFORE delegating the next milestone, folding corrections
into that next delegation. The verifier contract tells Codex that a milestone
task's `goalReached` refers to the LARGER goal, so mid-plan milestones come
back `goalReached:false`/`nextAction:"continue"` (the expected checkpoint
state) and the adapter's verdict→goal sync cannot mark the native Codex goal
complete before the final milestone. Milestones don't license micro-slicing:
within one milestone the fewer-larger-chunks delegation rule still applies,
and small single-stage tasks stay one delegation.

**Completion-gate detection (2026-07-04)** (locked by `completion-gate-smoke` +
`fusion-chat-parse-smoke`): Codex's verifier verdict remains the first gate;
this observes whether Claude ran its independent second check. A host-side
tracker (`backend/completionGate.cjs`, `createFusionGateTracker`) sits in
`emitSessionEvent` — one choke point covering BOTH planner families — and
latches when a `codex_implement` tool-result parses to `status:"completed"`
(capturing its `files` list; `needs_decision` never latches). Evidence =
a planner `Read` of a returned file (relative/absolute reconciled by
suffix-matching; when `files` is empty any successful Read counts), a
`codex_investigate` pass, or — codex planner only — native read-only shell
git evidence / file reads, surfaced as observe-only `native-tool` events the
panes ignore (`commandExecution` items in `fusionCodexBrain.cjs`, vocabulary
from the vendored app-server types; live emission still to be probed). Clean
settles carry `gate` and render a neutral muted chip on the "▣ Fusion · …"
turn-end row ("✓ checked · read changed file" / "unchecked"); an unchecked
settle arms a one-shot `FUSION_GATE_NUDGE` block prepended to the next fresh
non-plan, non-steer turn (the user echo carries only the user's text, so it
never renders). Aborted/errored settles are never annotated and keep the
latch; pane restart resets the tracker. Detection only — nothing is blocked.

Future
worktree isolation is a hardening option; the current implementation runs Codex
implementation turns in the pane's workspace with `danger-full-access` and
`approvalPolicy:"never"` so routine reads/writes do not bounce back through
Claude as approval fights. `codex_investigate` turns are platform-gated: on
POSIX they run under Codex's **read-only OS sandbox**
(`sandboxPolicy: {type:"readOnly"}`) so investigations are read-only by
enforcement; on **Windows** they keep the full-access path and remain read-only
by task contract only, because the Windows sandbox runner still fails to
bootstrap before ANY command runs (live-verified 2026-07-01, codex 0.142.4:
`CreateProcessAsUserW failed: 1312` on every exec, reads included).
`VIBE_FUSION_INVESTIGATE_SANDBOX` (`read-only` | `full`) overrides the gate in
either direction — flip it to `read-only` on Windows to re-test after a Codex
sandbox fix.

**Interrupting a turn:** the Fusion chat host control protocol has a dedicated
`interrupt` message (distinct from `stop`, which kills the whole session).
**Esc** is bound both in the composer and at the selected-pane window level
(the composer status row shows "interrupting…" beside the busy spinner; there
is no stop button). It sends Claude a stream-json `control_request` interrupt
over the live child's stdin. The host then emits `interrupted`, and the
renderer clears the running state from that acknowledgement — settling
still-running tool rows as aborted and closing the turn with a
"▣ Fusion · model · interrupted" line — so the session stays up for the next
message. Restart/Close remain the hard kill (`fusion-chat:stop` → `killChild`).

## Key finding: Codex 0.142.3 ships the app-server stack natively

A scan of the installed `codex-cli 0.142.3` (see the verified-facts memo) collapses
the build. We do **not** write a server, transport, auth, or protocol types:

| We assumed we'd build | Codex provides |
|---|---|
| Custom executor protocol | `codex app-server` — JSON-RPC app-server over stdio |
| Shared socket broker | Not used; each Fusion adapter spawns one private app-server child |
| Token auth / isolation | No inbound port; stdio child is reachable only by its adapter process |
| Hand-written protocol types | `codex app-server generate-ts --experimental` → version-pinned `.ts` bindings |
| Reviewer scaffolding (unused — see roles) | `codex review --uncommitted \| --base \| --commit` |
| A guessed clarifying-question channel | structured `ToolRequestUserInputParams` + typed approvals |

The **only substantial custom component** is the per-pane MCP↔app-server adapter.

## Architecture

```
   normal pane (claude)     normal pane (codex)     ← no adapter, no credential: vanilla
        │                        │
   real claude              real GLOBAL codex (via the PATH shim)

   Fusion pane A            Fusion pane B            ← Opus 4.8, talks to one MCP tool
        │ stdio MCP              │ stdio MCP
        ▼                        ▼
   fusion adapter (A)       fusion adapter (B)        ← the one thing we write:
        │  sessionId=A           │  sessionId=B          MCP server (north) +
        ▼                        ▼
   codex app-server (A)      codex app-server (B)   ← spawned by each adapter over stdio;
   embedded bundled binary   embedded bundled binary   one private Codex instance per
   pinned to pane cwd        pinned to pane cwd         Fusion terminal.
```

- **Per-pane, adapter-owned.** Each Fusion pane starts global `claude` headless,
  and that Claude process starts one MCP adapter. The adapter starts one embedded
  `codex app-server` child over stdio and eagerly initializes the pane's Codex
  thread on adapter startup, so the bridge is warmed before the first user turn.
  Closing the pane tears down that private executor path.
- **Cross-project safe.** Each Fusion pane's adapter starts its thread with the
  pane's `cwd`, so project A and project B do not share one app-server process.
- **Bundled-private Codex.** The server runs the bundled binary by absolute path
  (`process.resourcesPath`) in packaged builds and fails closed if it is missing.
  In dev, `resolveCodexBin()` may fall back to PATH. A user typing `codex` in any
  normal pane still gets their global CLI via the existing PATH shim.

### The adapter (the custom piece)

`backend/fusion-adapter.cjs` is spawned by Claude as a stdio MCP server. It is
**dual-protocol**: MCP server to Claude (north), app-server JSON-RPC client to its
own embedded Codex child (south). It exposes a small tool surface:

- `codex_goal_set(objective, status?, tokenBudget?)` — create/update Codex's
  native per-thread goal for the pane.
- `codex_goal_get()` — read Codex's native goal state, including usage and
  status.
- `codex_goal_clear()` — clear the native goal when the human abandons or
  replaces the objective.
- `codex_investigate(task)` — run a read-only Codex scouting pass that returns
  concise findings and relevant file paths/snippets for Claude's planning.
- `codex_implement(plan)` — run the approved plan on the pane's thread (edit, run
  tests, generate images, control browsers, fix, verify), streaming progress.
- `codex_respond(pendingId, decision)` — answer a parked approval or question.
- `codex_cancel()` — abort a stuck Codex turn locally (the wedge escape hatch);
  the thread survives so Claude can re-delegate without a pane restart.

Fusion starts the app-server thread with `config: { "features.goals": true }`,
the verified app-server override for enabling goals on that pane without
mutating the user's global Codex config. If a future/older/managed Codex build
rejects native goals, the goal tools return
`goalFeatureAvailable:false` instead of pretending goal state was stored.

## Approval / review loop (route to Opus, escalate to human rarely)

`app-server` sends approvals/questions as **server→client JSON-RPC requests**
(`ExecCommandApprovalParams`, `ApplyPatchApprovalParams`,
`FileChangeRequestApprovalParams`, `PermissionsRequestApprovalParams`,
`ToolRequestUserInputParams`, …). Rather than
auto-deciding or depending on MCP sampling (unverified in Claude Code), the adapter
is **turn-based**:

```
Claude → codex_goal_set({ objective: top-level user goal, status: "active" })
   adapter → app-server: thread/start with goals enabled if needed, then thread/goal/set
Claude → codex_investigate(task)             (optional read-only scouting)
   adapter → app-server: turn/start without verifier, returns findings + files
Claude → codex_implement(plan)
   adapter → app-server: thread/start with goals enabled (or reuse thread), send turn, stream items
   ...Codex edits / runs tests in the workspace...
   app-server → adapter: exceptional request/question      ← Codex may pause here
   adapter PARKS the request, returns to Claude:
        { status: "needs_decision", pendingId, kind, detail, diff }
Opus decides and calls:
   codex_respond(pendingId, "accept" | "acceptForSession" | "decline" | "cancel")
   adapter → sends the parked response → Codex resumes
   ...loops until { status: "completed", summary, files, goalReached,
                    bugsFound, missingRequirements, nextAction, verifierVerdict, goal }
```

Older Fusion builds parked routine Codex approvals back to Opus. The current
default is more autonomous: Codex threads launch with full workspace access and
`approvalPolicy:"never"`, so Opus watches, steers, plans, and reviews instead of
clearing read/write prompts. `needs_decision` remains a protocol path for
exceptional questions or permission requests, but it should not be part of the
normal read/edit/debug loop.
Read-only scouting is the exception to the thread default: `codex_investigate`
runs under Codex's read-only OS sandbox per turn on POSIX (on Windows it stays
on the full-access path — the read-only sandbox cannot bootstrap there yet) and
is always wrapped in a read-only investigation contract: gather context, run
non-mutating checks, and do not edit files, install packages, launch apps, or
make irreversible changes. (`VIBE_FUSION_INVESTIGATE_SANDBOX` = `read-only` or
`full` overrides the platform gate.)

Completion is not free-form text only. The adapter wraps each Codex task with a
verifier contract requiring a final `FUSION_VERDICT_JSON` line. The adapter
parses that into `goalReached`, `bugsFound`, `missingRequirements`,
`nextAction`, and `verifierVerdict`. Missing, malformed, or contradictory
verifier JSON fails closed as `goalReached:false` / `nextAction:"continue"`.
Claude must continue/redelegate unless the human says otherwise or Claude makes
an explicit override visible in the transcript.

Native Codex goals complement that verifier gate; they do not replace it. Claude
uses the native goal as the long-horizon coding objective, then delegates concrete
execution to Codex. The adapter creates a fallback goal from the first delegated
task if Claude did not call `codex_goal_set`, replaces completed fallback goals
for later unrelated work, and only auto-syncs the native goal to `complete` after
a true done verifier verdict. It does not auto-reactivate Codex-managed
`blocked`, `usageLimited`, or `budgetLimited` states.

Codex subagents are different from goals. In Codex 0.142.3 the native goal API is
an app-server client RPC, but multi-agent/subagent control is primarily exposed
as tools inside Codex turns, and Fusion currently rejects generic dynamic
`item/tool/call` requests from the embedded app-server. Fusion therefore does not
directly spawn or supervise Codex subagents yet; any internal Codex subagent
availability depends on Codex's own configured tool surface. The external
Claude-facing bridge stays at the goal/delegate/approval/verifier layer until
there is a stable app-server client method for spawning and supervising subagents
directly.

## Isolation — capability scoping among the same user's panes

Not an adversarial boundary (a single-user OS can't isolate the user from
themselves, and doesn't need to). Four independent reasons a normal pane stays
vanilla:

1. **Headless launch** — Fusion panes do not use the PTY shim path. The main
   process starts a per-pane headless Claude chat host with an explicit
   `--mcp-config`, architect prompt file, model, effort, allowlist, and denylist.
2. **Per-pane adapter** — each Fusion pane gets its own MCP config pointing at
   one adapter process. Non-Fusion Claude panes never see the `codex_*` tools.
3. **Per-pane app-server** — each adapter owns exactly one child
   `codex app-server` over stdio, so execution state, approvals, goals, and turn
   ids cannot cross between Fusion terminals.
4. **Local control channel** — adapter steering/interrupt endpoints bind to
   `127.0.0.1` and register with telemetry under that pane's session id. Main
   posts steering only to the URL stored for the matching pane id, and the
   adapter rejects mismatched session ids.
5. **Bundled binary** — reached only by the Fusion adapter, by absolute path in
   packaged builds; manual `codex` stays global everywhere.

## Host portability (the CC-host hedge)

The product is the custom workspace (the tiled multi-pane board, the heterogeneous
agent panes, the unified Fusion voice — none of which Claude Code can render), so
the custom UI stays. But the genuinely custom IP — the verifier contract, approval
parking, turn lifecycle, and goal sync — all lives in `fusion-adapter.cjs`, which
is a **plain stdio MCP server**. Its only coupling to the Electron host is three
env vars, each guarded so the surface no-ops when they are unset:

| Var | Powers | Guard |
|---|---|---|
| `VIBE_TERMINAL_CALLBACK_URL` | streamed Codex activity → renderer log | `postTelemetry` returns early |
| `VIBE_TERMINAL_TELEMETRY_TOKEN` | telemetry auth + control-server token | `postTelemetry` / `startControlServer` return early |
| `VIBE_TERMINAL_SESSION_ID` | per-pane scoping + control routing | both return early |

With all three unset the adapter is a complete host-free MCP server, so the whole
`codex_implement → needs_decision → codex_respond → verifier` loop can be driven by
a plain `claude --mcp-config …` with `--allowedTools "…,Read,Glob,Grep"
--tools "Read,Glob,Grep" --disallowedTools "Bash,Edit,MultiEdit,Write,NotebookEdit" --strict-mcp-config` (the execution lock is the edit/Bash denial plus the restricted built-in tool surface). This is kept as a **private validation/fallback hedge**, not a shipped
public skill — the capability has no moat, so publishing it would cannibalize the
app. The only thing lost off-host is the renderer activity relay and external
steer/stop (interrupt is native to `claude`).

> **Invariant — keep this free.** The portability above costs nothing only while
> the adapter stays decoupled. `scripts/backend/fusion-adapter-smoke.cjs`
> enforces it: `assertAdapterRunsHostFree` boots the adapter with the three vars
> unset and drives a full `initialize → tools/list → tools/call` round-trip, and
> `assertPortabilityGuards` pins the three env reads and their no-op guards.
> Re-coupling the adapter to host code (an unguarded env read, a `require()` of
> the Electron host) fails CI here.

## UI — one agent, OpenCode-parity transcript

Since the 2026-07-03 reskin the pane renders through the shared OpenCode-parity
chat kit (`frontend/components/ocChat.tsx`, the same row shapes/composer/footer
the Open Fusion pane wears — see `docs/frontend.md` for the full component
inventory). One interleaved transcript that reads as one Fusion agent. **Not**
split-lanes, **not** a side rail:

- Opus prose is markdown; thinking folds into "+ Thought" collapsibles; every
  turn closes with a "▣ Fusion · model · duration" line.
- Claude's own tools (Read/Glob/Grep) are OpenCode-style one-liner rows updated
  in place by their results. (The kit still renders Edit rows with a colored
  diff panel derived from `old_string`/`new_string` — unused in Fusion now that
  the planner is read-only, but shared with Open Fusion.)
- `codex_implement`/`codex_investigate` render as Task rows ("Executor/Scout
  Task — …") whose "↳ …" line ticks with the Codex side-channel's
  command/file/message activity; completed rows read "↳ N updates · 12s" and
  click open a report built from the bridge's JSON (findings/summary, files,
  verifier verdict). Goal updates and other bridge calls are muted one-liners.
- `/details` (footer toggle + slash command, default ON) hides
  completed-successful tool rows and internal worklines; running/failed/Task
  rows always stay. Pre-turn engine chatter (launch-time stderr, warmup notes)
  never enters the transcript — the FUSION hero owns a fresh pane.
- `/compact` (2026-07-04) frees context by sending the literal `/compact` as a
  stream-json user message — the claude CLI interprets it headlessly (verified
  live by `scripts/backend/fusion-compact-spike.cjs` on 2.1.200: it emits
  `system/status` `status:"compacting"` then a status line with
  `compact_result` + `compact_error`). The host normalizes those to
  `compact-start`/`compacted` events; the pane renders "Compacting context…" /
  "Context compacted." activity rows (or the error, e.g. "Not enough messages
  to compact."). Blocked while a turn is running. Fixture-locked in
  `fusion-chat-parse-smoke`.

Mid-turn sends (steering) do not drop into the scrolling transcript, where the
stream would bury them: the pane pins them above the composer with a QUEUED
badge (same mechanic as the Open Fusion pane) until the next assistant message
absorbs them, at which point they join the transcript as `Steer: ...` right
where Claude actually saw them. If the steer lands while `codex_implement` is
actively waiting on the executor, the adapter now keeps that executor turn
running and early-returns `{status:"steer_routing", ...}` to the planner. The
planner must answer with `codex_steer_resolve`: `decision:"push"` sends the
steer into the still-running executor, while `decision:"replan"` interrupts the
executor so the planner can re-delegate on the same persistent thread. If the
planner does not answer promptly, a watchdog pushes the buffered steer into the
running executor as the safe default. Steering outside an active implementation
turn still falls back to the planner-thread steer path, so it is never silently
dropped.

## Milestones

- **M0 — Foundation:** bundle scaffold (codex-bin resolver + `extraResources`),
  version-pinned app-server schema material, and an app-server boot smoke test.
- **M1 — Plumbing:** `fusion` session flag, Fusion launcher, and per-pane Fusion
  file generation.
- **M2 — End-to-end:** the adapter + `codex_implement` (autonomous, no approvals)
  streaming Codex's work into a pane.
- **M3 — The loop:** turn-based approvals + `codex_respond` + the Opus-reviews-plan
  gate.
- **M4 — Custom Fusion UI + model labels:** the unified role-tagged log; Opus 4.8 /
  Codex GPT-5.5 labeling.
- **M5 — Hardening:** embedded-binary release gates, protocol coverage, status
  lifecycle, launch quoting, and teardown edges.

## Open questions

1. **Exact Codex model id for GPT-5.5** — pin via `-m <id>` on the thread; the
   literal string must be verified against the installed Codex, not assumed.
2. **Exact Claude model argument for Opus 4.8** — the UI label is Opus 4.8; the
   literal CLI model value should be verified against the installed Claude Code
   release.
3. **app-server is `[experimental]`** — its wire format churns. Mitigations: pin
   the bundled version, isolate the protocol behind the generated bindings, and let
   the M0 smoke test fail CI on a breaking bump.
4. **Worktree vs in-place** — future worktree isolation could give Opus a stable
   review target and quarantine edits until approved. The current implementation
   is in-place `danger-full-access` for Codex to avoid approval fights.

## Likely file touch-points (when implemented)

| Piece | Location |
|---|---|
| `fusion` flag on a session | `frontend/types.ts` (`AgentSession`) |
| Fusion launcher + unified role-tagged log + badges | `frontend/` (launcher, `components/TerminalPane.tsx`, `styles.css`) |
| Per-pane Fusion files + adapter-control registry | `backend/agentTelemetry.cjs` |
| Fusion chat host + adapter-owned app-server lifecycle | `backend/fusionChatHost.cjs` + `backend/fusion-adapter.cjs` |
| Codex-bin resolve and packaged fail-closed behavior | `backend/main.cjs` |
| Generated protocol bindings (pinned) | `vendor/codex-appserver/<version>/` |
| Bundling | `package.json` `build.extraResources` |
| Boot smoke test | `scripts/backend/fusion-appserver-smoke.cjs` + `package.json` script |
