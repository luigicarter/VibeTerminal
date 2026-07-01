# Open Fusion

> **Status: embedded terminal mode implemented.** vibeTerminal now has an Open Fusion
> launcher/pane that runs OpenCode with pane-scoped `OPENCODE_CONFIG`,
> `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, and `OPENCODE_TUI_CONFIG`,
> plus Brain/Body model pickers and pane-level slash commands in the app UI. The
> headless OpenCode server / SDK custom chat UI path remains design work. See
> `docs/fusion-terminal.md` and `docs/fusion-unification.md` for the shipped
> Fusion (Claude + Codex) it generalizes.

## The idea

Fusion (shipped) fuses two *first-party agentic harnesses*: **Opus 4.8** as the
read-only planner/architect/reviewer and **Codex GPT-5.5** as the executor,
bridged over a hand-rolled MCP ↔ `codex app-server` adapter.

**Open Fusion** generalizes that pattern past Anthropic + OpenAI: the user picks
**any two models from the OpenCode catalog** (models.dev, ~75 providers) and
assigns one to the **Planner** role and one to the **Executor** role. The premise
the user gave: *models are different and have gaps in their ability* — so let the
user mix complementary specialists (e.g. a strong reasoner to plan, a strong
coder to execute) instead of being locked to one vendor pair.

This is the true "OpenRouter for complementary specialists" framing from
`docs/fusion-terminal.md`, now with the model pair chosen by the user rather than
hardcoded.

### Positioning — keep it SEPARATE from Fusion

Open Fusion is a **distinct mode**, not a setting inside Fusion. They have
different value propositions and conflating them muddies both:

| | Fusion | Open Fusion |
|---|---|---|
| Engines | Two **first-party harnesses** (Claude Code + Codex), each a vendor-tuned agentic loop | Two **models** under OpenCode's **one generic loop** |
| Model choice | Locked (Opus + Codex GPT-5.5) | User picks any two from the catalog |
| Ceiling | Higher per-role (vendor harness) | Lower per-role (generic loop) |
| Build complexity | High (dual-protocol bridge, app-server child, control server) | **Lower** — delegation is native OpenCode config |
| Pitch | Premium fused harnesses | Flexible / open, any two models |

## Why OpenCode is the right substrate

OpenCode's agent/subagent system is *built* for per-role models, so most of what
Fusion hand-builds collapses into configuration:

| Fusion concept | OpenCode-native mechanism |
|---|---|
| Opus planner pane | A **primary agent** (`mode: primary`) with its own `model` |
| Codex executor | A **subagent** (`mode: subagent`) with a *different* `model` |
| "Planner delegates to executor" | The built-in **`task`** tool |
| Read-only lock (no Edit/Write/Bash for planner) | Per-agent **`tools` / `permission`** config |
| MCP bridge to the executor | OpenCode **MCP support** is native |
| Model pinning per role | `model` field per agent |
| Approval routing | OpenCode **`permission`** (`ask` / `allow` / `deny`) |

The entire Claude+Codex bridge stack — the `codex app-server` child, the
`fusion-adapter.cjs` MCP server, the 127.0.0.1 control server, the
fire-and-forget telemetry POST — **has no analogue here.** Both roles live in one
OpenCode runtime with one message loop, which also means one process stamps the
transcript ordering (the coherence seam Fusion fights in
`docs/fusion-unification.md` doesn't arise).

## Architecture sketch

- **Current engine:** embedded OpenCode **TUI/CLI** in a vibeTerminal PTY. The
  app writes per-pane OpenCode config/theme/prompt files into its runtime session
  directory and exposes them only to that terminal process via `OPENCODE_*`
  environment variables. It sets both file paths and `OPENCODE_CONFIG_CONTENT`
  with inline prompts so the pane's role config wins even when the project has
  its own OpenCode config. It does not write Open Fusion config into the user's
  global OpenCode config.
- **Future engine option:** an OpenCode **server** (`opencode serve` + its
  SDK/HTTP API), driven headlessly — the same shape as today's headless-Claude +
  codex-app-server Fusion, but *one* server hosts both roles.
- **Role config — a generated per-pane `opencode.json`:**

```jsonc
// simplified from the generated config
{
  "model": "<user pick A>",
  "agent": {
    "planner": {
      "mode": "primary",
      "model": "<user pick A>",
      "permission": {
        "bash": "deny",
        "edit": "deny",
        "task": { "*": "deny", "executor": "allow" }
      },
      "prompt": "{file:./openfusion-planner.md}"
    },
    "executor": {
      "mode": "subagent",
      "model": "<user pick B>",
      "prompt": "{file:./openfusion-executor.md}"
    }
  }
}
```

- **Delegation:** the planner calls the executor through the native **`task`**
  tool — no adapter.
- **Review gate:** the executor can self-review its work and return findings,
  diffs, test results, and a recommendation, but the final **done vs guide a
  correction pass** decision belongs to the Planner/intelligence layer. If the
  work is not done, the Planner writes the next corrective instruction and sends
  the executor another `task` call.
- **Work ownership:** the Planner stays in the loop as the observer/steerer. The
  Executor performs the concrete implementation work: code edits, shell commands,
  command-result analysis, fixes, and self-review.
- **Launcher/UI:** the ribbon has an "Open Fusion" variant. The pane shows
  custom-colored OpenCode controls for **Brain** (Planner) and **Body**
  (Executor) model IDs. The same controls accept pane-level slash commands:
  - `/brain <model>` / `/planner <model>` / `/primary <model>`
  - `/body <model>` / `/executor <model>` / `/secondary <model>`
  - `/model brain <model>` / `/model body <model>`
  - `/models <brain-model> <body-model>`
  - `/models brain=<model> body=<model>`
  - `/swap`
  - `/reset`

  A future catalog-backed picker should populate model suggestions from
  OpenCode's provider + model catalog and flag providers the user is authed for.

```
┌─ Open Fusion pane ────────────────────────────────────────┐
│  Planner  [ model A ▾ ]     Executor  [ model B ▾ ]        │
│                                                            │
│  OpenCode TUI/CLI (one runtime)                            │
│    planner  (primary,  read-only)  ──task──▶  executor     │
│                     ▲                          (subagent,  │
│                     └── watches evidence + diff ─ writes)  │
│                        decides done vs next correction      │
└────────────────────────────────────────────────────────────┘
```

## The three decisions that actually matter

1. **Planner model quality is load-bearing.** The *planner* decides when to hand
   off via `task`. A model that follows instructions poorly or won't reliably
   delegate degrades the whole system regardless of executor quality. The Planner
   dropdown should be **curated / flagged for orchestration-capable models**, not
   a raw 75-model dump.

2. **Planner-owned completion gate.** Fusion's quality guarantee comes from Codex
   being a *hard, independent completion gate*. Open Fusion should not let the
   executor close its own loop directly. The executor may perform self-review,
   but that review is evidence for the Planner, not the final authority. The
   Planner reviews the diff/findings and either declares done or writes a better
   corrective instruction for the executor.

   Still open: whether the evidence comes from executor self-review plus Planner
   diff review, or from a distinct third **`verifier` subagent** that reports
   back to the Planner. In both versions, the Planner/intelligence layer owns the
   decision to finish or re-delegate.

3. **Auth.** Each picked model needs credentials. OpenCode manages provider
   auth/keys itself, but the UX must surface "no key for this provider" at
   **pick time**, not at first turn.

## Reusable vs new work

- **Reused now:** the read-only-lock idea, the ribbon launcher pattern,
  OpenCode terminal/session plumbing, and pane-scoped runtime files.
- **New now:** the two-model Brain/Body controls, slash command parser,
  per-pane **`opencode.json` generation**, and Planner-owned review/correction
  prompts.
- **Future:** OpenCode **server lifecycle + SDK driving**, a richer
  `FusionChatPane`-style transcript, catalog-backed model picker, and optional
  third verifier subagent.

Today's Open Fusion implementation extends the existing **CLI-only** OpenCode
integration: vibeTerminal launches `opencode --agent planner` as a terminal agent,
discovers threads via `opencode session list --format json`, and injects
pane-scoped config through environment variables including
`OPENCODE_CONFIG_CONTENT` (see
`backend/agentTelemetry.cjs`, `backend/main.cjs`, `frontend/sessionLaunch.ts`,
`frontend/openFusion.ts`, and `frontend/components/TerminalPane.tsx`). It does
**not** drive the OpenCode server. The server/SDK path is still new integration
work.

## Decision status

Direction: **build Open Fusion as a mode separate from Fusion**. Current shipped
slice = embedded OpenCode terminal, roles = two user-picked model IDs mapped to
primary(planner, read-only) + subagent(executor) via generated per-pane
OpenCode config, delegation via the native `task` tool, UI = custom-colored
OpenCode terminal controls with Brain/Body pickers and slash commands. Future
slice = optional `FusionChatPane`-style UI driven by OpenCode server/SDK. The
completion/review gate belongs to the Planner/intelligence layer: executor
self-review is allowed, but it reports back to the Planner, which decides done
vs another guided executor pass. The Planner remains the observer/steerer, while
the Executor performs code edits, shell commands, command-result analysis, fixes,
and self-review.

**Future decision:** the embedded terminal path gates completion through the
Planner prompt and OpenCode `task` delegation. A future server/custom-chat path
can decide whether to keep executor self-review as the evidence source or add a
third verifier subagent that reports to the Planner.

**Verify before building the future server slice** (surfaces churn fast; notes
current to early 2026): the OpenCode server/SDK surface and the model-catalog
API. The current embedded terminal slice is covered by smoke tests for launch,
workspace restore, parser edge cases, generated config, and runtime env wiring.
