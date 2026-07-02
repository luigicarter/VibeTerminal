# Open Fusion

> **Status: embedded terminal mode implemented, incl. native model pickers.**
> vibeTerminal has an Open Fusion launcher/pane that runs OpenCode with
> pane-scoped `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`,
> `OPENCODE_CONFIG_CONTENT`, and `OPENCODE_TUI_CONFIG`, with Brain/Body roles
> defined inside the generated OpenCode config. Users pick the Brain and
> Executor provider/model through native in-TUI catalog pickers
> (`/brain-model`, `/executor-model`) that flag provider auth at pick time.
> The visible interaction surface is the embedded OpenCode TUI/CLI, not a
> separate app-level model bar. The headless OpenCode server / SDK custom chat
> UI path remains design work. See `docs/fusion-terminal.md` and
> `docs/fusion-unification.md` for the shipped Fusion (Claude + Codex) it
> generalizes.

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
  app writes per-pane OpenCode config/theme/prompt files under vibeTerminal's
  user-data directory (`%APPDATA%\vibeTerminal\openfusion\sessions\...` on
  Windows) and exposes them only to that terminal process via `OPENCODE_*`
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
  "default_agent": "planner",
  "model": "<user pick A>",
  "command": {
    "delegate": {
      "agent": "executor",
      "model": "<user pick B>",
      "subtask": true
    },
    "investigate": {
      "agent": "investigator",
      "model": "<user pick B>",
      "subtask": true
    },
    "review": {
      "agent": "planner",
      "model": "<user pick A>"
    }
  },
  "agent": {
    "planner": {
      "mode": "primary",
      "model": "<user pick A>",
      "permission": {
        "bash": "deny",
        "edit": "deny",
        "task": { "*": "deny", "executor": "allow", "investigator": "allow" }
      },
      "prompt": "{file:./openfusion-planner.md}"
    },
    "executor": {
      "mode": "subagent",
      "model": "<user pick B>",
      "prompt": "{file:./openfusion-executor.md}"
    },
    "investigator": {
      "mode": "subagent",
      "model": "<user pick B>",
      "permission": {
        "bash": "deny",
        "edit": "deny",
        "task": { "*": "deny" }
      },
      "prompt": "{file:./openfusion-investigator.md}"
    }
  }
}
```

- **Delegation:** the planner calls the executor through the native **`task`**
  tool — no adapter. The generated `/delegate <task>` OpenCode command is a
  native command configured with `agent: "executor"` and `subtask: true`, so it
  appears in OpenCode slash autocomplete and runs through OpenCode's normal
  subagent path.
- **Read-only investigation:** the `investigator` subagent (and its
  `/investigate <question>` command) is the scouting half of the workflow. It is
  **permission-locked read-only** — `edit: deny`, `bash: deny`, and
  `task: {"*": "deny"}` so it can't launder writes by delegating to the
  executor. Unlike Fusion's `codex_investigate` (read-only by task contract),
  this lock is enforced by OpenCode's permission system regardless of model
  quality.
- **Approval routing (live-verified, OpenCode 1.17.11):** permission `ask`s
  raised inside an executor turn surface as a **TUI dialog to the human**
  ("Permission required … Allow once / Allow always / Reject") — they do NOT
  route to the Planner, and OpenCode has no native way for a parent agent to
  answer a subagent's permission request. In practice the executor is allow-all
  for routine work (edits/bash), mirroring Fusion's `approvalPolicy:"never"`,
  so only edge asks reach the human: `.env` reads, external-directory access,
  and doom-loop detection. **Work-level decisions do route through the Brain**
  by topology: the executor's `question` permission is denied and its only
  output channel is the task result, so "I'm blocked on X" returns to the
  Planner, which decides itself and re-delegates or asks the human. Fusion-style
  "brain answers the executor's permission requests" would require the future
  server/SDK slice (subscribe to `permission.asked`, reply via the permission
  API after consulting the Planner).
- **Review gate:** the executor can self-review its work and return findings,
  diffs, test results, and a recommendation, but the final **done vs guide a
  correction pass** decision belongs to the Planner/intelligence layer. If the
  work is not done, the Planner writes the next corrective instruction and sends
  the executor another `task` call.
- **Work ownership:** the Planner stays in the loop as the observer/steerer. The
  Executor performs the concrete implementation work: code edits, shell commands,
  command-result analysis, fixes, and self-review.
- **Launcher/UI:** the ribbon has an "Open Fusion" variant. After launch, the
  pane is a normal OpenCode TUI with the generated `planner` primary agent and
  `executor` subagent selected through OpenCode config. Model and command
  affordances must remain native to OpenCode's CLI/TUI surface (for example its
  status line, `/models`, agent selector, and command palette), not a React
  overlay that can drift from the running session.

  The pane also ships a pane-scoped OpenCode TUI plugin with native slash
  commands (all verified live against OpenCode 1.17.11):

  - `/brain-model` (`/brain`) opens a catalog-backed native picker for the
    pane-scoped Brain/Planner model: first a provider select (connected
    providers grouped first; unauthenticated ones flagged with an
    `opencode auth login <id>` hint), then that provider's models newest-first,
    plus a custom-id escape hatch. The pick is saved under the Open Fusion
    session directory and applies on the next pane restart.
  - `/executor-model` (`/executor`, `/body`, `/body-model`) is the same picker
    for the pane-scoped Executor model.
  - `/brain-model-live` opens OpenCode's own `/models` selector for the current
    Brain turn.
  - `/openfusion` shows the pane-scoped Brain/Executor model state, flagging
    models whose provider is not authenticated.

  The pickers read the catalog and auth state at pick time from the OpenCode
  server via the plugin SDK (`client.provider.list()` returns `all`, `default`,
  and `connected`). Live role-model switching should use an OpenCode-native
  server/TUI capability if one is added; app-side controls must not pretend to
  mutate an already-running OpenCode session independently. Until OpenCode
  exposes live subagent model mutation in the TUI/server API, picked Brain and
  Executor models are restart-applied pane settings.

  Loader gotchas locked in by smoke tests (OpenCode 1.17.11 behavior): the TUI
  plugin host only loads plugins declared in the TUI config, so the generated
  `tui.json` carries a `plugin: [<file url>]` entry pointing at the plugin. The
  plugin file lives *outside* the pane's `config/` dir on purpose — anything
  under a config dir's `plugins/` folder is also scanned by the server-side
  plugin loader, which rejects tui-only modules ("must default export an object
  with server()") on every pane start.

```
┌─ Open Fusion pane ────────────────────────────────────────┐
│  OpenCode TUI/CLI (one runtime)                            │
│    planner  (primary,  read-only)  ──task──▶  executor     │
│        │            ▲                          (subagent,  │
│        │            └── watches evidence + diff ─ writes)  │
│        │               decides done vs next correction     │
│        └──task──▶  investigator (subagent, hard read-only: │
│                    edit/bash/task all denied — scout only) │
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
   **pick time**, not at first turn. *Shipped:* the `/brain-model` and
   `/executor-model` pickers group connected providers first, label the rest
   "needs auth: opencode auth login <id>", and toast the login command if a
   model from an unconnected provider is picked anyway; `/openfusion` flags
   unauthenticated providers in the status line.

## Reusable vs new work

- **Reused now:** the read-only-lock idea, the ribbon launcher pattern,
  OpenCode terminal/session plumbing, and pane-scoped runtime files.
- **New now:** per-pane **`opencode.json` generation** for Brain/Body role
  models, Planner-owned review/correction prompts, generated OpenCode command
  files, and a pane-scoped TUI plugin whose `/brain-model` and
  `/executor-model` are **catalog-backed native pickers** with pick-time auth
  flags.
- **Future:** OpenCode **server lifecycle + SDK driving**, a richer
  `FusionChatPane`-style transcript, an app-side launch-time model pair picker,
  and optional third verifier subagent.

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
OpenCode config, delegation via the native `task` tool, UI = the embedded
OpenCode terminal itself, model choice = native in-TUI catalog pickers
(`/brain-model`, `/executor-model`) persisted per pane in `models.json`.
Saved pane models win over launch defaults on restart (the pickers own them);
invalid saved values fall back to the launch opts, never to hard defaults.
Future slice = optional `FusionChatPane`-style UI driven by OpenCode server/SDK. The
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
workspace restore, generated config, runtime env wiring, and ensuring the React
pane does not render app-level Open Fusion model controls over the TUI.
