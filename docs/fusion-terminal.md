# Terminal Fusion

> **Status: implemented (M2 engine + M3 headless chat UI + M4 embedded per-pane Codex).**
> A Fusion pane is a custom **Claude-Code-style chat UI**: Claude runs HEADLESS
> (stream-json) as **Opus 4.8** the architect and delegates execution to Codex
> (**GPT-5.5**) via a per-pane MCP adapter; approvals route back to Opus. Each
> Fusion terminal spawns its **OWN embedded** Codex `app-server` over **stdio**
> (the bundled binary, `vendor/codex-bin/<plat>` → `resources/` via
> `extraResources`; `resolveCodexBin()` permits a PATH fallback only in dev) — no
> shared server, no ws. Packaged builds fail closed if the embedded Codex binary
> is missing. The xterm presentation is retired for Fusion (other panes keep xterm).
> Headless multi-turn uses a long-lived `--input-format stream-json` process
> (M3.1 spike). Verified: typecheck/build + smoke suite (incl. the embedded
> binary booting `app-server`, + `fusion-chat-parse`) + clean boot. Remaining: a
> live turn needs `claude login` + `codex login`; transcript ephemeral (Resume
> via `claude --resume`); per-platform binaries + code-signing for release.

Goal: a **Fusion** terminal that fuses the *capabilities* of two coding agents
behind one surface — Claude (Opus 4.8) as the architect/reviewer/designer and
Codex (GPT-5.5) as the executor — so the user talks to one terminal and the right
model handles each sub-task. Think "OpenRouter, but for **complementary
specialists** rather than interchangeable models": the router doesn't pick one
engine for the whole prompt, it **decomposes** the task and routes sub-tasks by
specialty. The routing intelligence is Claude itself (an LLM that decides when to
delegate), not a static rule table.

## Roles — strictly non-overlapping

The two models **cannot do each other's jobs** ("they cannot be fitting each
other"). Clean separation is a design invariant, not a guideline:

| Opus 4.8 (the Claude pane — thinker/reviewer/designer) | Codex GPT-5.5 (the executor — driven via the bridge) |
|---|---|
| Architecture decisions | Editing files |
| Debugging strategy | Running tests |
| Threat-modeling a design | Fixing compile/runtime errors |
| Reviewing a Codex plan before it touches a large repo | Refactors |
| "What are we missing?" analysis | Repo navigation |
| Tradeoff reasoning | Implementing from an approved plan |
| | Iterative debugging loops |

Opus **never** edits files or does hands-on debugging in Fusion mode. Codex
**never** does the judgment review/diff-check — `codex review` is *not* used as a
review pass; the authoritative review is Opus's. (Codex still *runs* tests —
mechanical execution — which doesn't overlap with Opus *reading and judging* the
diff.)

**The loop:** Opus plans/designs → Codex implements + runs tests + fixes → produces
a diff → Opus reviews the result and decides the next strategy → Codex fixes.
Future worktree isolation is a hardening option; the current implementation runs
Codex in the pane's workspace with `workspace-write` and on-request approvals.

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
  `codex app-server` child over stdio. Closing the pane tears down that private
  executor path.
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

- `codex_implement(plan)` — run the approved plan on the pane's thread (edit, run
  tests, fix), streaming progress.
- `codex_respond(pendingId, decision)` — answer a parked approval or question.

## Approval / review loop (route to Opus, escalate to human rarely)

`app-server` sends approvals/questions as **server→client JSON-RPC requests**
(`ExecCommandApprovalParams`, `ApplyPatchApprovalParams`,
`FileChangeRequestApprovalParams`, `ToolRequestUserInputParams`, …). Rather than
auto-deciding or depending on MCP sampling (unverified in Claude Code), the adapter
is **turn-based**:

```
Claude → codex_implement(plan)
   adapter → app-server: thread/start (or resume), send turn, stream items
   ...Codex edits / runs tests in the workspace...
   app-server → adapter: fileChange requestApproval        ← Codex pauses here
   adapter PARKS the request, returns to Claude:
        { status: "needs_decision", pendingId, kind, detail, diff }
Opus diff-checks it (its job), decides, and calls:
   codex_respond(pendingId, "accept" | "acceptForSession" | "decline" | "cancel")
   adapter → sends the parked response → Codex resumes
   ...loops until { status: "completed", diff, testResults }
```

This makes "route to Opus" structurally true — Opus is literally the one calling
the next tool. Opus answers from its own judgment and only **asks the human when it
decides it must** (irreversible op, ambiguous intent, security) — by asking
in-pane, which lights up the existing `agent.waiting` attention dot. No inbound
port, no polling channel needed. `acceptForSession` lets Opus pre-approve a class
to cut round-trips. Codex threads launch with `-a on-request --sandbox
workspace-write` so Codex self-filters trivia and only escalates meaningful
decisions.

## Isolation — capability scoping among the same user's panes

Not an adversarial boundary (a single-user OS can't isolate the user from
themselves, and doesn't need to). Four independent reasons a normal pane stays
vanilla:

1. **Config** — the shim appends `--strict-mcp-config --mcp-config … --add-dir …`
   only when the pane's env carries `VIBE_TERMINAL_FUSION_*`, set only for Fusion
   panes (mirrors the existing per-pane `--settings` injection).
2. **Per-pane only** — the shim injects `--mcp-config` (and the architect prompt)
   for Fusion panes only, so non-Fusion claude panes never see the `codex_*`
   tools. The config is non-strict, so the user's own MCP servers still load in a
   Fusion pane.
3. **Transport** — no inbound socket is opened. The adapter owns a child
   `codex app-server` process over stdio, so only that adapter can speak to that
   Codex instance.
4. **Bundled binary** — reached only by the Fusion adapter, by absolute path in
   packaged builds; manual `codex` stays global everywhere.

## UI — unified role-tagged log

One interleaved transcript, each line badged by role/model (Opus one accent, Codex
another), approvals inline. **Not** split-lanes, **not** a side rail.

```
┌─ Fusion terminal ───────────────────────────────────┐
│ 🔵 Opus   plan: add rate limiting (3 steps)           │
│ 🟢 Codex  edit  src/mw/rateLimit.ts                   │
│ 🟢 Codex  run   npm test → 12 pass                    │
│ 🔵 Opus   diff-check: missing 429 Retry-After header  │
│ 🟢 Codex  fix   add Retry-After header                │
│ 🔵 Opus   ✓ looks correct — done                      │
└───────────────────────────────────────────────────────┘
```

The renderer maps app-server item events (streamed via the telemetry callback
server) to Codex-tagged lines; Opus's own turns are the Claude-tagged lines;
parked approvals render as inline decision cards.

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
   is in-place `workspace-write` with on-request approvals.

## Likely file touch-points (when implemented)

| Piece | Location |
|---|---|
| `fusion` flag on a session | `frontend/types.ts` (`AgentSession`) |
| Fusion launcher + unified role-tagged log + badges | `frontend/` (launcher, `components/TerminalPane.tsx`, `styles.css`) |
| Per-pane fusion env + shim flag injection + adapter source | `backend/agentTelemetry.cjs` |
| Fusion chat host + adapter-owned app-server lifecycle | `backend/fusionChatHost.cjs` + `backend/fusion-adapter.cjs` |
| Codex-bin resolve and packaged fail-closed behavior | `backend/main.cjs` |
| Generated protocol bindings (pinned) | `vendor/codex-appserver/<version>/` |
| Bundling | `package.json` `build.extraResources` |
| Boot smoke test | `scripts/backend/fusion-appserver-smoke.cjs` + `package.json` script |
