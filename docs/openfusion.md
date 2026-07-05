# Open Fusion

> **Status: native chat pane over a headless OpenCode server (2026-07-01),
> full data ownership (2026-07-02).**
> An Open Fusion pane is now a vibeTerminal-native chat UI
> (`frontend/components/OpenFusionChatPane.tsx`) driven by a per-pane
> `opencode serve` child managed by `backend/openFusionChatHost.cjs` — the
> OpenCode TUI is no longer rendered. This replaced the embedded-TUI slice
> because the TUI's branding surface is closed: its tui.json schema has no
> logo/splash override and its plugin API stops at dialogs/toasts/commands
> (verified against the 1.17.11 binary), so an Open Fusion pane could never
> stop looking like stock opencode. The server slice also unlocks what the TUI
> could not: in-pane permission approvals (`/permission/{id}/reply`) and a
> live-switchable Brain model (per-prompt `model` override on `prompt_async`).
> The pane keeps the same generated pane-scoped `OPENCODE_CONFIG` /
> `OPENCODE_CONFIG_CONTENT` role config (planner primary + executor +
> read-only investigator subagents). Model picks persist in the same
> `models.json` (Brain applies live; Executor is baked into the generated
> config, so it restart-applies). See `docs/fusion-terminal.md` and
> `docs/fusion-unification.md` for the shipped Fusion (Claude + Codex) it
> generalizes.
>
> **Data ownership (2026-07-02):** Open Fusion owns ALL of its data. Every
> pane's `opencode serve` runs with `XDG_DATA_HOME`/`XDG_CONFIG_HOME` pointed
> at an app-owned OpenCode home (`%APPDATA%\vibe-terminal\openfusion\
> opencode-home\{data,config}` on Windows, created by
> `agentTelemetry.ensureOpenFusionOpencodeHome`, shared across panes, exempt
> from the stale-pane-dir sweep). opencode 1.17 resolves its entire data tree
> from those vars (verified in the shipped binary; there is no `OPENCODE_DATA`
> escape hatch), so conversation threads (`opencode.db`), provider credentials
> (`auth.json`), snapshots, tool output, and logs all live inside vibeTerminal
> — and the user's personal OpenCode install (`~/.config/opencode/*`,
> `~/.local/share/opencode/*`) is **never read or written**. Thread
> discovery/resume for Open Fusion panes carries an `openFusion: true` flag on
> `agent-thread:latest`; main injects the matching XDG env so the discovery
> host's `opencode session list` spawns list the app store (plain opencode
> terminal panes keep the user's global store). A one-time best-effort
> migration seeds the app store with a copy of the global `opencode.db` (+wal)
> so pre-isolation Open Fusion threads stay resumable; credentials are
> deliberately NOT copied — providers are reconnected inside the app.
> Personal CLI threads ride along inside the db snapshot but never surface
> (discovery filters by launch-time cutoff, resume only confirms app-saved
> ids). Known documented leak: executor shell commands inherit the XDG
> overrides (benign on Windows). Locked by
> `scripts/backend/openfusion-isolation-smoke.cjs`.
>
> **Parallel executor children (2026-07-05):** Open Fusion preserves
> OpenCode's native ability to run multiple `task` children inside one pane.
> The Planner prompt permits multiple same-turn task calls only for genuinely
> independent, disjoint scopes; dependent/checkpointed milestones stay
> sequential and must be reviewed before the next delegation. The host tracks
> active executor children in `activeExecutorTasks: Map<childSessionId, task>`
> and the steering router snapshots every active child so it can target a
> selected `childSessionId` for inject/replan. The pane keys Task-row progress
> by child `sessionID` instead of by the shared `executor` role, so two live
> executor rows can tick independently and each row carries an
> Executor/Investigator chip.
>
> **No default models (2026-07-02):** the pane assumes nothing on open. The
> old hardcoded Planner/Executor defaults are gone everywhere (backend
> `agentTelemetry.cjs`/`main.cjs`, renderer `openFusion.ts`); `""` means "not
> chosen yet", generated configs omit `model` fields entirely, and
> `openFusionChatHost.input()` refuses turns without an explicit Brain model.
> First-run gate in the pane: a "Connect a provider" button is ALWAYS offered
> (the keyless opencode zen provider counts as connected, so a
> zero-connected-providers check would hide it forever — it did, until
> 2026-07-03), alongside Brain/Executor picks from actually-connected
> providers; the composer blocks non-slash turns until both are set. Once a
> pair has been picked, it persists app-wide (localStorage
> `vibe-terminal:last-openfusion-models`): new Open Fusion panes start from
> the last-used pair instead of re-running the gate. `/connect` with no
> argument opens a provider browser (popular providers first — anthropic,
> openai, google, openrouter, … — then the ~149-provider catalog
> alphabetically, scrollable with an explicit "N more" row; it used to be a
> hard silent cap of 14 alphabetical rows, which is why OpenRouter never
> appeared). `/connect <id>` matches case-insensitively and refuses provider
> ids that are not in the OpenCode catalog (a stored key for an unknown id
> would never be used) — unless the catalog itself failed to load
> (`catalogOk:false` on the providers event), in which case the pickers say
> the list is partial and the attempt proceeds. `/disconnect` with no
> argument opens the same browser over connected providers. While a connect
> flow is open, every stage takes keyboard focus (method buttons included)
> and composer Enter hands focus to the flow — pasted API keys can no longer
> land in the chat input. A connect/disconnect in one pane disposes the other
> panes' idle server instances and re-emits their provider lists, so every
> pane sees the credential immediately (busy panes pick it up at their next
> dispose/restart).
>
> **Plan mode (2026-07-04):** Shift+Tab / `/plan` / `/auto` / the footer chip
> flip the pane between Auto and Plan. The mode is renderer-only state
> (`session.openFusionRunMode`) that rides EVERY send —
> `sendUserTurn(id, text, mode)` — and the host picks the opencode agent per
> prompt (`agent: "plan" | "planner"` in the `prompt_async` body), so there is
> no set-mode plumbing and no accept race. The generated config carries a
> second read-only primary agent `plan` (same git-evidence bash allowlist as
> the planner; `task {"*": deny, investigator: allow}` — the executor is
> permission-DENIED while planning, the scout is not). A plan-mode turn that
> settles cleanly with Brain prose arms an "Implement this plan?" bar (arming
> ground truth = the host's user-echo `mode`, emitted by the same call that
> chose the agent); accepting flips to Auto and sends "Implement the plan."
> as one race-free planner turn. Two semantics to know: a message queued
> mid-turn is absorbed by the RUNNING turn's agent regardless of the chip
> (safe direction — plan is read-only), and panes launched from a build
> without the plan agent get a friendly "restart the pane" error via the
> `planAgent` start-payload capability flag. Prompt-side, plan turns swap the
> standing gate reminder for a plan variant under the SAME
> `OPEN_FUSION_GATE_MARKER` prefix (rehydration filters by that prefix).
> Locked by `agent-telemetry-smoke` (agent shape, task-map key order, prompt
> file) and `openfusion-chat-parse-smoke` (plan reminder variant).
>
> **/compact (2026-07-04):** `/compact` (alias `/summarize`) calls
> `POST /session/{id}/summarize` `{providerID, modelID}` with the Brain model
> — the same endpoint the OpenCode TUI's `/compact` uses. The host passes a
> 300s timeout (the default 30s `request()` timeout would destroy the POST
> mid-summarization). The server's `session.compacted` SSE event (root-only)
> renders as a "Context compacted." activity row — server-side auto-compaction
> (overflow-driven; only models with a known context limit get it) produces
> the same marker for free. The pane blocks the command while busy and until
> a Brain model is picked.
>
> **Questions (2026-07-04):** `question.asked` / `question.replied` /
> `question.rejected` (the V1 question-service vocabulary used by opencode's
> `ask` tool and `plan_exit`) previously fell through the normalizer's
> `default` case — any tool question hung the turn invisibly. The pane now
> renders a panel per request (requests queue FIFO; a pending permission takes
> precedence and owns the keys): single-select buttons answer and advance,
> `multiple` questions toggle + Submit, `custom` questions accept typed
> composer text, Esc rejects the whole request
> (`POST /question/{requestID}/reject`). Replies post
> `{answers: string[][]}` to `POST /question/{requestID}/reply` — option
> LABELS (or the typed string), one inner array per question, in request
> order. Payload shape note: fields were read from the 1.17.13 source and
> string-confirmed in the shipped 1.17.11 binary; the parse-smoke fixture
> encodes that shape.
>
> **Engine contract (live-verified against OpenCode 1.17.11):**
> `opencode serve --port 0 --hostname 127.0.0.1` (stdout line reports the
> port; basic auth via a per-pane random `OPENCODE_SERVER_PASSWORD`);
> `POST /session`, `POST /session/{id}/prompt_async` (agent + parts +
> optional per-prompt model), `POST /session/{id}/abort`,
> `GET /session/{id}/message` (resume rehydration),
> `POST /permission/{requestID}/reply` `{reply: once|always|reject}`,
> `GET /config/providers` (connected) + `GET /provider` (full catalog), and
> the `/event` SSE feed (`message.part.delta` streaming, `message.part.updated`
> snapshots, tool parts with `state.status` pending→running→completed,
> task-spawned child sessions on the same feed via `session.created.parentID`,
> `session.status busy` / `session.idle`, `permission.asked`). GOTCHA
> (verified in the 1.17.11 source, 2026-07-03): `message.part.delta.field` is
> the part PROPERTY being appended, not a content kind — BOTH text and
> reasoning parts stream with `field:"text"` (reasoning content lives in
> `part.text`; `field:"reasoning"` never occurs). The normalizer in
> `backend/openFusionChatHost.cjs` therefore tracks partID→part.type from the
> snapshot that `text-start`/`reasoning-start` always emit before the first
> delta, routes deltas to `assistant-text`/`thinking` by that tracked type
> (unknown-part deltas are dropped; the next snapshot re-delivers them), and
> dedupes delta-vs-snapshot text by tracking emitted length per part id —
> fixture-tested by `scripts/backend/openfusion-chat-parse-smoke.cjs`.
> Classifying by `field` instead used to double-render every reasoning part as
> a text + thinking bubble pair. Every streamed
> `assistant-text`/`thinking` event carries a `streamId` (`sessionID:partID`)
> because several parts stream CONCURRENTLY on the one feed (parallel Scout
> subagents, reasoning beside text) — the pane keys bubbles by it; bucketing by
> role alone interleaved concurrent streams chunk-by-chunk into one garbled
> paragraph (2026-07-03). A finished part's final snapshot carries `time.end`;
> the normalizer surfaces it as a `stream-end` event so the pane retires that
> bubble's live caret per-part instead of leaving every finished row blinking
> until the turn settles (turn-wide clearing on result/interrupt/error stays
> the net for aborted parts, which never get a `time.end`). `stream-end` is
> once-per-part, so content stragglers arriving AFTER the end snapshot (bus
> reordering) are dropped — emitting them would reopen a pane bubble whose
> caret nothing retires.
>
> **Transcript rendering (OpenCode-TUI parity, 2026-07-03):** the pane renders
> the same row shapes as OpenCode's own TUI (verified against the v1.17.11
> `packages/tui` source) wearing Open Fusion's palette. The row renderer,
> glyph/label helpers, spinner, markdown/diff blocks, and block-letter wordmark
> now live in the shared kit `frontend/components/ocChat.tsx` under the
> `.oc-skin` CSS scope — the Fusion pane renders through the same kit
> (proseRole "opus"), so row-shape changes land in both panes. Tool calls are ONE row
> per callID — created on `tool-call`, updated in place by the matching
> `tool-result` — with OpenCode's icon glyphs (`$` bash, `→` read, `✱`
> glob/grep, `←` edit/write, `%` webfetch, `◈` websearch, `⚙` generic, `│`/`✓`
> task) and states ("~ pending" before input, bright while running, muted when
> done, red + click-to-expand error on failure, strikethrough when
> permission-denied). Bash renders as a block panel (`$ command` + output
> collapsed at 10 lines, "Click to expand"); Edit renders the host-forwarded
> `meta.diff` as a colored unified diff; `todowrite` renders OpenCode's
> "# Todos" `[✓]/[•]/[ ]` checklist; delegations render as OpenCode Task rows
> (Executor/Investigator chip + "Executor Task — description" + a live
> "↳ current tool / N toolcalls" line, completed as "↳ N toolcalls · 12s";
> click reveals the extracted task report). Live Task progress is attributed by
> child `sessionID`, not role, so parallel executor children do not overwrite
> each other's progress line.
> Brain text is markdown prose (react-markdown + GFM); thinking renders as
> OpenCode's "Thinking" spinner → "+ Thought: title" collapsible; subagent text
> streams are Details-lane worklines ("↳ …" last-line tickers). Each turn ends
> with OpenCode's "▣ Brain · model · duration" line ("· interrupted" on
> aborts). The Details toggle (`/details`, default ON like OpenCode) hides
> completed-successful tool rows and subagent worklines; running/failed rows
> and Task rows stay. The composer is OpenCode's prompt box (accent left bar,
> "Ask anything..." cycling placeholders, agent · model meta row inside, a
> status row with the knight-rider block spinner + "esc interrupt" while busy
> and token/cost + hints when idle — no send button, Enter sends), and the pane
> footer is OpenCode's status bar: cwd (parent muted, name bright) left; "△ 1
> Permission", `/details`, and the "• OpenFusion" brand right. The empty state
> is OpenCode's home: a block-letter OPEN FUSION logo in OpenCode's exact glyph
> style (left word muted, right word bold in the pane accent).
>
> **Mid-turn steering (verified against the 1.17.11 run loop):**
> `prompt_async` during a busy turn is legal — the server persists the user
> message immediately, `ensureRunning` merely awaits the in-flight run, and the
> loop re-reads the message list each iteration (its exit check
> `lastUser.id < lastAssistant.id` forces an extra iteration for a message that
> arrived during the final step), so the queued message is absorbed at the next
> Brain step. On abort the queued message survives in history and rides into
> the next turn's context. The host tags such echoes `{type:"user",
> queued:true}` (from its event-derived `turnBusy` latch) and emits
> `{type:"step-start"}` on each NEW root assistant message; the pane pins
> queued sends above the composer — opencode's own QUEUED badge mechanic —
> until a step-start/turn boundary flushes them into the transcript.
>
> **OpenFusion steering router (2026-07-05):** classic Fusion's
> `codex_implement` steering route is adapter-owned and can early-return a
> planner decision object while the executor keeps running. Open Fusion's
> executor delegation is a native OpenCode `task` tool, so the host runs a
> hidden Planner decision pass when a mid-turn steer arrives during active
> executor work. The router sees every active child snapshot and returns
> `inject`, `replan`, or `ignore` plus a `childSessionId`; `inject` posts the
> refined steer into that child session, while `replan` aborts only that child
> and queues an amended root Planner prompt. If the router omits or names a
> stale child, the host falls back to the most recently started active executor.
>
> **Provider auth (in-pane, OpenCode-parity, live-verified):** the pane
> replicates OpenCode's own "Connect a provider" workflow over the same server
> APIs its TUI dialog uses:
>
> - `GET /provider/auth` → per-provider auth-method list
>   (`{type:"oauth"|"api", label, prompts?}`). Providers absent from the map
>   (most of the catalog, e.g. openrouter) default to a single API-key method.
>   On this install 10 providers register special methods (openai ChatGPT
>   OAuth, github-copilot device flow, xai, digitalocean, poe, gitlab,
>   snowflake-cortex, plus api-with-prompts cloudflare-workers-ai /
>   cloudflare-ai-gateway / azure).
> - Method `prompts` (text/select fields like Cloudflare `accountId`, Azure
>   `resourceName`, GitHub `deploymentType`) are collected first. For api
>   methods the answers ride the credential's `metadata` record:
>   `PUT /auth/{providerID}` `{type:"api", key, metadata?}`.
> - OAuth methods: `POST /provider/{id}/oauth/authorize` `{method, inputs?}` →
>   `{method:"code"|"auto", url, instructions}`. The pane opens the URL
>   (validated `shell.openExternal` via `app:open-external`), offers copy
>   link/device-code, then `POST /provider/{id}/oauth/callback`
>   `{method, code?}` — "code" sends the pasted code, "auto" sends none and
>   BLOCKS server-side until the browser device flow finishes (host uses a
>   10-minute timeout; failures surface as `ProviderAuthOauthCallbackFailed`).
> - `DELETE /auth/{providerID}` disconnects. The running instance only
>   reflects auth changes after `POST /instance/dispose` (the same
>   dispose+bootstrap the TUI performs after its own connect flow) — and the
>   dispose emits `server.instance.disposed` and then ORPHANS the `/event`
>   stream (the connection stays open but silent), so the host reattaches its
>   SSE subscription whenever it sees that event. Disk sessions survive; the
>   next `prompt_async` works unchanged.
>
> In the pane: picking a "needs auth" provider (or `/connect <id>`) walks
> method choice → prompt fields → key entry or browser OAuth; `/disconnect
> <id>` removes the credential. Stale/cancelled flows are ignored via a
> per-flow nonce echoed on `oauth-authorize`/`auth-result` events. Keys and
> codes only transit memory; they are never logged or echoed into the
> transcript.
>
> **Custom OpenAI-compatible providers (2026-07-03):** "Add custom provider"
> in the `/connect` browser (also `/custom-provider`) walks name → base URL →
> optional API key → one or more models (endpoint model id + a display name +
> an optional context window, Enter to skip) → review/save. A given context
> window ("128k"/"1m" shorthand accepted) is written as the model's
> `limit.context` plus a derived `limit.output` (min(32000, context/4),
> floor 256) — derived because opencode's compaction threshold with an
> unknown output limit is `context − 32000` (its default output cap, verified
> in the 1.17.11 binary), which clamps to 0 for sub-32k models and would
> re-compact on every step. Skipping the context leaves `limit.context` 0 =
> unknown: calls still work (the endpoint enforces its real window; blowing
> past it surfaces as a failed turn), but opencode disables auto-compaction
> for that model (`if (limit.context === 0) return false`) and shows no
> usage percentage. The definition lands in the app-owned
> global config (`opencode-home/config/opencode/opencode.json`, filename
> pinned by an empty-`{}` seed in `ensureOpenFusionOpencodeHome` — without it
> opencode's first write creates `opencode.jsonc`), written by the pane's own
> server via `PATCH /global/config` — live-verified 1.17.11: that PATCH
> re-reads the file, merges the body, persists it, AND refreshes the running
> instance, so the provider is usable immediately with no dispose or pane
> restart. An EMPTY `{}` PATCH performs the same file re-read and is the
> nudge other idle panes get (`reloadConfig` on the provider refresh),
> because a bare `/instance/dispose` does NOT re-read config files while
> `OPENCODE_CONFIG_CONTENT` is set. A PATCH can never DELETE a key (nulls
> don't remove entries), so removal rewrites the file in main
> (`agentTelemetry.removeOpenFusionCustomProvider`, checks both `.json` and
> `.jsonc`) before the host drops the credential and nudges the servers. The
> key is optional — a config-defined provider counts as connected without one
> (keyless local endpoints like LM Studio / llama.cpp are first-class); when
> present it goes through the same `PUT /auth/{id}` credential store as every
> other provider. Connected entries now carry OpenCode's `source` field
> ("config" = user-added custom, which the `/disconnect` browser offers to
> remove definition-and-key). The provider id derives from the display name
> (catalog collisions get a `-custom` suffix so a definition never silently
> merges into a stock provider; re-using an existing custom slug redefines it
> — PATCH merges, so shrinking a model list needs remove + re-add). Naming is
> the point: the same underlying model id can live under two
> differently-named providers and stay distinct Brain/Executor picks
> (`provider/model`). Locked by
> `scripts/backend/openfusion-custom-provider-smoke.cjs` plus a live host
> E2E (add → connected picker entry → remove) run against 1.17.11.

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
  global OpenCode config. The generated executor/planner prompts carry
  concurrent-edits guidance (locked by `agent-telemetry-smoke`): a stale-write
  rejection whose drift is not the agent's own work may mean another agent pane
  is editing the same checkout — report the overlap instead of overwriting it
  (the renderer's shared-folder chip, `frontend/cwdConflicts.ts`, surfaces the
  same overlap to the human).
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
        // Git evidence allowlist — key ORDER is load-bearing (findLast:
        // last matching key wins), see "Gate hardening" below.
        "bash": {
          "*": "deny",
          "git status *": "allow",
          "git diff *": "allow",
          "git log *": "allow",
          "git show *": "allow",
          "git * --output*": "deny"
        },
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
- **Review gate (decided 2026-07-03, hardened 2026-07-03):** two stages. The
  executor prompt mandates a **capped self-review loop** before it returns
  control: re-read the full diff as a reviewer (correctness, scope drift, edge
  cases, leftover debug code, validation gaps), fix and re-validate, review
  again — stop on a clean pass; after the second fix pass, one final review
  reports anything still unfixed instead of looping.
  The Planner then reviews that evidence as the **independent second gate**; the
  final **done vs guide a correction pass** decision belongs to the
  Planner/intelligence layer. If the work is not done, the Planner writes the
  next corrective instruction and sends the executor another `task` call.

  **Gate hardening (2026-07-03).** Field report: after several turns a Brain
  took the executor's self-review as truth. Root causes: the gate was two
  sentences of prompt prose with no enforcement; the Planner had **no
  independent evidence channel** (`bash: deny` meant the only diff/test output
  it ever saw was inside the executor's own report); and multi-turn drift (each
  accepted report becomes in-context precedent for rubber-stamping the next).
  Four coordinated fixes, none of which adds a verifier subagent:

  1. **Read-only git evidence channel.** The planner's `bash` permission is now
     a pattern allowlist: `git status/diff/log/show` allowed, everything else
     (and `git * --output*`, git's write-to-file escape) denied. Live-verified
     1.17.11 semantics this depends on: agent-level `permission.bash` accepts a
     glob→action object; rules evaluate with `findLast` so the **last matching
     key wins** (insertion order, NOT specificity — the `"*": "deny"` catch-all
     must stay FIRST and the `--output` deny LAST); unmatched commands default
     to `ask`, not deny, so the catch-all is what preserves the read-only lock;
     a trailing `" *"` matches the bare command and arguments but not
     `git difftool`; globs are full-string anchored and case-insensitive on
     win32; the shell tool tree-sitter-parses chained commands and
     permission-checks **each subcommand**, so `git diff && rm -rf /` cannot
     launder the deny.
  2. **Operational completion rule.** The planner prompt's completion rule is
     now a mandatory checklist: ≥1 independent check (git diff/status, read the
     changed files, or an investigator pass) before presenting work as done,
     name the check in the reply, treat a report without verbatim evidence as
     automatically not-done, no exemption for a so-far-reliable executor.
  3. **Per-turn standing reminder.** `openFusionChatHost.input()` appends a
     marked reminder part (`[Open Fusion standing reminder] …`) to every Brain
     turn via `buildPlannerTurnParts` — countering long-context salience decay.
     The pane echo carries only the user's own text, the SSE normalizer drops
     non-assistant parts, and `rehydrateMessages` filters marker-prefixed parts,
     so the reminder never renders in the transcript, live or resumed.
  4. **Verbatim evidence contract.** The executor prompt and `/delegate`
     template require verbatim primary artifacts (exact commands + exit status,
     verbatim final test-runner summary lines, the diff itself), not summaries.
  5. **Checkpointed delegation.** Multi-stage work (multi-file features,
     refactor + behavior changes, anything where an early wrong choice
     cascades) must not go to the executor as one giant handoff: the planner
     defines 2–5 independently verifiable milestones, delegates ONE milestone
     per `task` call, and must run the same independent check (git evidence,
     read the changed files, or an investigator pass) between milestones
     before releasing the next — corrections fold into the next delegation.
     The executor prompt and `/delegate` template carry the matching scope
     discipline: implement only the named milestone, report impacts on later
     milestones instead of acting on them. Micro-slicing is explicitly ruled
     out — a milestone is a verifiable increment, and small single-stage tasks
     stay one delegation.
  6. **Independent parallel fan-out.** The Planner may emit multiple `task`
     calls in one assistant turn only for independent, disjoint work with no
     ordering dependency or shared file ownership. Parallel children must each
     get self-contained scope and acceptance criteria. Anything that depends on
     reviewing a prior milestone, or might edit/verify the same files, remains
     sequential under the checkpoint rule.
  7. **Verified-done detection + one-shot nudge (2026-07-04).** The gate is no
     longer purely an honor system: a host-side tracker
     (`backend/completionGate.cjs`, `createOpenFusionGateTracker`) observes the
     live normalized event stream and mechanically records whether an
     independent check happened between an executor `task` returning and the
     Brain turn settling. Evidence = root-session allowlisted git bash
     (`git status/diff/log/show`), a root `read` of a file the executor
     edited (child edit/write paths are accumulated per child session and
     linked via the task result's `childSessionId`), or an investigator task.
     Clean settles carry `gate: {status: "verified"|"unverified", evidence}`;
     the pane renders it on the "▣ Brain · …" turn-end row as a deliberately
     neutral muted chip ("✓ checked · git diff" / "unchecked"). A settle that
     presented an executor report unchecked arms a ONE-SHOT corrective part
     (`OPEN_FUSION_GATE_NUDGE`, same marker prefix so rehydration strips it)
     that rides the next fresh non-plan turn. Aborted/errored settles are
     never annotated and keep the latch; new prompts and `/compact` do not
     clear it; resume/restart resets the tracker (documented, deliberate —
     child sessions are not rehydrated). Detection only: nothing is blocked.

  Locked by `agent-telemetry-smoke` (permission shape incl. key order + prompt
  anchors), `openfusion-chat-parse-smoke` (reminder/nudge parts + rehydration
  strip + gate tracker over the fixture stream + normalizer sessionID/
  childSessionId fields), and `completion-gate-smoke` (latch/evidence/nudge
  semantics).
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
   executor close its own loop directly. The executor runs a mandatory capped
   self-review loop, but that review is evidence for the Planner, not the final
   authority. The
   Planner reviews the diff/findings and either declares done or writes a better
   corrective instruction for the executor.

   Decided 2026-07-03: the evidence comes from the executor's own capped
   self-review loop plus Planner diff review — no third verifier subagent. The
   Planner/intelligence layer owns the decision to finish or re-delegate, and
   the investigator stays pinned to the Executor model by design.

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
  `FusionChatPane`-style transcript, and an app-side launch-time model pair
  picker.

Today's Open Fusion implementation drives the **OpenCode server**: the
singleton helper `backend/openFusionChatHost.cjs` spawns one `opencode serve`
per pane (pane-scoped `OPENCODE_*` env from
`agentTelemetry.prepareOpenFusionFiles`, per-pane basic-auth password),
normalizes the `/event` SSE feed into the same high-level chat-event vocabulary
the Fusion pane uses, and speaks JSONL with `backend/main.cjs`
(`openfusion-chat:*` IPC channels; renderer surface
`window.vibe.openFusionChat` in `preload/preload.cjs`). The pane
(`frontend/components/OpenFusionChatPane.tsx`) renders Brain/Executor/Scout
voices, delegation cards, in-pane permission approvals, model pickers backed by
`GET /config/providers` + `/provider`, and resume via
`GET /session/{id}/message` rehydration. Thread discovery still uses the
existing `opencode` provider (server sessions are ordinary OpenCode sessions on
disk).

**Resume picker (2026-07-03):** `/resume` (and the header's RotateCcw button)
no longer jumps straight to the stashed last chat — it opens a saved-chat
picker listing EVERY app-created session for the pane's folder, newest first
with generated titles and ages, filterable by typing (the same slash-menu
picker chassis as `/connect`). Data comes from `agent-thread:list`
(`window.vibe.agentThreads.list`), a `list: true` lookup on the discovery host
that shares `selectOpenCodeThreadRefs` with latest-discovery and runs ONLY
against the app-owned store — main fails the request closed rather than fall
through to the user's global OpenCode store, and raises the cutoff to the
migration marker's `migratedAt` so personal CLI threads inside the seeded db
snapshot never surface (pre-isolation Open Fusion threads stay resumable via
their stashed `resumeRef`s, but do not appear in the list — same rule
latest-discovery already applied). An empty store lists as "No saved chats";
a listing FAILURE renders as "Couldn't read saved chats" plus a
"Resume last chat" fallback row against the stashed `resumeRef` — an error
must never masquerade as an empty history. Rows whose session id is active in
another pane are marked "open in another pane" and refused on selection (two
panes must never drive one session id); the pane's own current conversation is
excluded. Selection hands the full threadRef to `App.resumeSession(scope,
session, targetRef)`, which reuses the deliberate-resume plumbing (stop →
relaunch with `nextLaunchMode: "resume"`, confirm-before-resume self-heal,
`GET /session/{id}/message` rehydration), stashing the outgoing conversation
as the next `resumeRef`. Locked by
`scripts/backend/openfusion-isolation-smoke.cjs`.

**Ghost sessions + real titles (2026-07-04):** the picker used to be a wall of
identical "vibeTerminal Open Fusion" rows, most of them EMPTY — every pane
start (including every app reopen) eagerly `POST /session`-ed with that fixed
title, and opencode never re-titles a session created with an explicit title,
so pane-open ghosts outnumbered and outdated the real conversations. Fixed at
both ends: the host now defers session creation to the FIRST input and titles
the session with that prompt (`ensureSession` in
`backend/openFusionChatHost.cjs`; the `engine-ready` event replaces the eager
session event as the renderer's provider-prefetch trigger), and the listing
hides legacy untouched ghosts (`updated === created` to the millisecond — a
real conversation bumps `updated` on its first message). Resume/confirm paths
ignore the ghost filter, so a stashed ghost id still resumes.

The old embedded-TUI launch path (`opencode --agent planner` inside a
PTY with `OPENCODE_TUI_CONFIG`, TUI plugin pickers) is superseded; the config
generator still writes the theme/tui/plugin files, which stock `opencode` runs
in that directory can pick up, but no pane launches the TUI anymore.

## Decision status

Direction: **build Open Fusion as a mode separate from Fusion**. Current shipped
slice = the `FusionChatPane`-style UI driven by the OpenCode server (the former
"future slice"), roles = two user-picked model IDs mapped to primary(planner,
read-only) + subagent(executor) via generated per-pane OpenCode config,
delegation via the native `task` tool, UI = `OpenFusionChatPane` (OpenCode-TUI
parity skin: block-letter hero, OpenCode tool rows/diff blocks/Task rows,
prompt box + status footer, permission options — in Open Fusion's palette and
branding), model choice =
in-pane pickers (`/brain-model`, `/executor-model`) persisted per pane in
`models.json`. Saved pane models win over launch defaults on restart (the
pickers own them); invalid saved values fall back to the launch opts, never to
hard defaults. Brain picks apply live (per-prompt model override); Executor
picks restart the pane (the model is baked into the generated config). The
completion/review gate belongs to the Planner/intelligence layer: the executor
runs a mandatory capped self-review loop (stop on a clean pass; after two fix
passes a final review reports unfixed findings honestly), and its report is
evidence for the
Planner, which decides done vs another guided executor pass as the independent
second gate — no third verifier subagent (decided 2026-07-03). Hardened
2026-07-03 after a field report of a Brain rubber-stamping executor reports in
long conversations: the gate is now operational, not aspirational — the Planner
has a read-only git-evidence bash allowlist, a mandatory independent-check
completion rule, a host-appended per-turn standing reminder, and a verbatim
evidence contract on executor reports (see "Gate hardening" under Review gate).
The Planner
remains the observer/steerer, while the Executor performs code edits, shell
commands, command-result analysis, fixes, and self-review.

**Verify before building the future server slice** (surfaces churn fast; notes
current to early 2026): the OpenCode server/SDK surface and the model-catalog
API. The current embedded terminal slice is covered by smoke tests for launch,
workspace restore, generated config, runtime env wiring, and ensuring the React
pane does not render app-level Open Fusion model controls over the TUI.
