# Terminal integration audit

Date: 2026-09-04. Audited workspace version: 0.1.81.

Implementation follow-up: see [terminal runtime and board behavior](terminal-runtime.md) for the repaired architecture, current capabilities, controls, and verification commands. The findings below describe the pre-repair audit.

Scope: standalone Codex, Claude, OpenCode, Cursor, Kimi, Kimi + CC, Qwen, Gemini, Aider, and plain terminal panes. Priority is accurate status and actual titles across all integrations, with future orchestration in mind. Fusion/Open Fusion are architectural reference points; their full behavior was outside this audit.

## Assessment

The reported problems have concrete causes. The app launches terminals, but the metadata used to describe those terminals is unevenly integrated. It mixes shell lifetime, provider turns, output activity, cached conversation titles, and placeholder pane names. These signals do not yet form a reliable interface for orchestration.

Codex has the strongest thread/turn attribution machinery, but thread discovery can fail in ordinary lifecycle transitions. That failure affects both naming and completion. Other providers have their own gaps; correcting only Codex would leave the shared problem intact.

This audit added documentation and local diagnostic scripts only. It did not change application behavior or launch real provider turns.

## Confirmed findings

### 1. Actual terminal titles never reach pane metadata — all PTY integrations

`frontend/components/TerminalPane.tsx:1575` displays only `session.threadRef?.title || session.name`. The terminal byte stream reaches xterm, but there is no `onTitleChange` subscription, OSC title handler, or terminal-title field/event in the app bridge and domain model.

A program can emit an OSC title change and the pane header will keep displaying its cached thread title or placeholder. This applies to plain terminals as well as agent TUIs. The vendored Codex implementation explicitly emits OSC 0 titles in `vendor/codex-official/codex-rs/tui/src/terminal_title.rs:56`.

**Repair:** capture terminal titles and retain them separately from provider conversation titles and user aliases. Define an explicit display policy that can show the current actual terminal title. Preserve the values across hidden panes and reattachment; do not make the existence of a mounted xterm the only durable source.

### 2. Codex conversation names are read from the wrong source

`backend/agentThreads.cjs:140` assumes Codex has no session title. Its parser reads `session_meta.payload.name` and otherwise extracts the first user message. It does not read `session_index.jsonl`.

The vendored Codex source defines an append-only index containing `id`, `thread_name`, and `updated_at`; the most recent name wins (`vendor/codex-official/codex-rs/rollout/src/session_index.rs:20`). Its thread reader uses that name (`thread-store/src/local/read_thread.rs:287`).

**Reproduced:** a virtual root thread named “Actual renamed title” in the index is returned by vibeTerminal as “Original prompt.” The index is never read.

**Repair:** resolve the real name by thread ID using the provider's supported data source for the installed version; use a first-prompt preview only as an explicitly lower-quality fallback. Handle subsequent renames.

### 3. Title refresh is stale or unreachable — shared renderer

`TerminalPane.tsx:1452` stops refreshing as soon as any title exists; `:1514` also rejects a result if the existing title is nonempty. Once a preview or earlier name is captured, CLI renames do not update the pane through this path.

There is a separate implementation error: Kimi, Kimi + CC, and Qwen are included in `TITLE_REFRESH_PROVIDERS` at `:98`, but `runTitleRefresh` at `:1494` rejects every provider except Claude and Codex.

**Reproduced using actual functions:** an untitled bound session is considered eligible for all four tested providers. Codex makes one metadata request; Kimi, Kimi + CC, and Qwen make zero.

**Repair:** centralize provider title capabilities and refresh policy. Remove conflicting gates, refresh on rename/relevant metadata changes, and distinguish a real name from a prompt preview.

### 4. Thread discovery can disconnect a live Codex pane from its conversation

Three paths contribute:

- **Workspace remount:** `TerminalPane.tsx:1204` resets the lookup timestamp to the current time when the component mounts again. The PTY may merely reattach to the existing process. `backend/agentThreads.cjs:268` filters by thread **creation** time, so the original live thread is now too old. This matters when the initial binding had not finished before switching away.
- **Children compete with the root:** the Codex parser drops `session_meta.source`; candidate selection only checks cwd, creation time, originator, and excluded IDs. Same-folder subagent rollouts are accepted. A root and child together produce ambiguity, and history listing includes the child. The vendored protocol contains explicit subagent source information.
- **Late metadata has no normal recovery:** discovery gives up after 90 seconds (`TerminalPane.tsx:1325`); failed or ambiguous lookups stop scheduling (`:1279`). Enter restarts title harvesting, which requires an already-bound thread ID, rather than restarting identity discovery.

**Reproduced:** the actual discovery module returns `ambiguous` for one root plus one child. Moving the lookup cutoff one second after their creation returns `pending`, despite both files existing.

This directly affects status: `frontend/attention.ts:209` defers Codex completion until the root ID is known, and `App.tsx:2318` queues those events. A discovery failure can therefore leave both the title and completion unavailable.

**Repair:** make the launch generation and pane-to-root binding backend-owned. Reattachment must preserve its original discovery epoch. Prefer authoritative root identity from provider lifecycle data when that data distinguishes roots; exclude children and reconcile ambiguous/late metadata without guessing ownership.

### 5. Codex status still contains unconditional guesses and an interrupted-turn race

- Every bare Enter invokes the start fallback (`TerminalPane.tsx:927`; `attention.ts:395`). There is no check that this was a submitted prompt rather than an empty Enter or menu confirmation, nor a switch disabling the fallback after authoritative hooks are established.
- `App.tsx:2156` changes a running Codex pane to waiting after 60 seconds without refreshing activity. The timer also applies to hook-observed turns. Output after that timeout can revive running (`:2192`). Silence does not establish that the agent is waiting for the user.
- The interrupt callback deletes the active turn ID (`App.tsx:4968`) without retaining it in the settled/cancelled set. A subsequent Enter records a null previous ID (`:2205`). A delayed completion for the interrupted turn can then pass the pending-submit gate and settle the newer activity.

**Reproduced using actual functions:** the watchdog changes running to waiting without a completion/wait event; bare Enter qualifies unconditionally; the delayed old-turn completion is accepted for the described state. The final case is a verified state-machine path, not a measured frequency of real callback races.

**Repair:** use provider lifecycle events for authoritative state; report unavailable/stale telemetry separately. Scope events to launch/thread/turn, retain cancelled identities, and make heuristic fallback explicit. A watchdog should degrade observation confidence rather than declare a user wait.

### 6. Parallel subagent bookkeeping loses work — non-Codex hook integrations

Every non-Codex subagent start calls `applyAgentRunning(..., true)` (`App.tsx:2128`). That clears the existing depth (`:2082`) before incrementing it.

**Reproduced using actual functions:** start → depth 1; another start → depth 1; one stop → depth 0. Completion suppression is then false even though another child should remain open.

The deeper limitation is that these events are counted brackets without task identities (`backend/agentTelemetry.cjs:3622`). Duplicate, missing, or reordered events cannot be reconciled reliably from a counter alone.

**Repair:** correct the reset immediately, then retain provider task identities where available. Providers exposing only brackets must advertise that weaker capability; orchestration must not treat the counter as an authoritative child-task registry.

### 7. Lower-level lifecycle and transport defects affect every PTY provider

- `backend/main.cjs:1130` decodes each stdout Buffer separately before joining JSON lines. A UTF-8 character split between chunks is corrupted. **Reproduced:** `A─🙂B` becomes `A���🙂B`. This affects output and can also affect non-ASCII OSC titles. Use a streaming decoder or buffer bytes until decoding is safe.
- `terminal:create` awaits preparation (`main.cjs:2139`) and then sends create without checking whether the pane was closed. Kill does not invalidate that pending operation (`:3100`). **Reproduced using actual handlers:** hold preparation, close, release preparation → host receives `kill`, then `create`. Introduce cancellation tied to launch generation.
- PTY exit means the **shell** exited: `backend/ptyHost.cjs:198` spawns a persistent shell and `:241` types the agent command into it. Agent process exit, agent turn completion, and shell exit need separate records.

## Coverage across integrations

This table describes the audited code paths, not a live certification of installed CLI versions. The shared missing OSC title path applies to every row.

| Integration | Existing status source | Existing identity/name source | Principal gaps |
| --- | --- | --- | --- |
| Codex | Passive invocation hooks, completion notify, Enter/watchdog fallback | Rollout metadata and first prompt | Wrong name source; discovery/root binding; heuristic status; interrupted-turn attribution |
| Claude / Open Claude Code | Injected provider hooks | Transcript metadata and title records | Titles stop refreshing; generic telemetry lacks thread/turn IDs; shared subagent counter |
| OpenCode TUI | Installed plugin events | CLI session listing | Cached title; generic pane-level events; plugin installation depends on config location |
| Cursor | Project hooks and process fallback | Local transcript discovery | Cached prompt/title; generic events lack thread/turn IDs |
| Kimi / Kimi + CC | Config hooks and process fallback | Local session index/state | Refresh gate rejects both; shared counter; shared-home hook compatibility needs validation |
| Qwen | Settings hooks and process fallback | Local transcript discovery | Refresh gate rejects it; prompt-derived name; shared counter |
| Gemini / Aider | Renderer output heuristic and shell events | No provider thread-discovery dispatch | Launchable terminal profiles, without native lifecycle/title integration in audited modules |
| Plain terminal | Output heuristic and shell events | Placeholder name | Actual OSC title ignored; no structured foreground-command lifecycle |

Provider lists are split across `frontend/sessionLaunch.ts`, `frontend/attention.ts`, `backend/agentTelemetry.cjs`, and `backend/agentThreadHost.cjs`. This duplication already caused the contradictory title-refresh gates. A shared capability definition should govern both the UI and runtime adapters.

Additional follow-up risks, kept separate from reproduced defects:

- OpenCode plugin installation hardcodes `~/.config/opencode` and returns if it does not exist (`agentTelemetry.cjs:3284`). Alternate config homes and fresh installations need a live compatibility check.
- Stock Kimi and Kimi + CC hooks now share a config home but use different markers and event sets. Shared-file behavior is confirmed; whether the installed stock version rejects the custom event set was not independently verified.

## Required contract before orchestration

Use one normalized session service consumed by both pane UI and orchestration. Provider adapters can have different capabilities, but they must express missing information honestly.

| Data | Required separation |
| --- | --- |
| Identity | Stable pane ID, launch generation, provider, root thread ID, turn ID, child/task IDs when available |
| Naming | Current terminal title, current conversation title, optional user alias, fallback preview; each with source and update time |
| Lifetime | Shell process, agent process, foreground turn, and background tasks |
| Status | Starting, idle, working, waiting for approval/input, completed, failed, interrupted; observation availability tracked separately |
| Evidence | Provider event versus inferred activity, capability/trust state, freshness, event identity/order information |

The renderer should subscribe to snapshots and updates. Hiding or remounting a pane must not reset identity, rename tracking, or lifecycle observation. Orchestration should consume IDs and structured state; display names are mutable labels, and terminal output/title text is not proof of completion.

Recommended implementation order:

1. Fix discovery epochs/root filtering, cancelled-turn attribution, counter reset, launch cancellation, and UTF-8 transport. These are bounded correctness changes.
2. Implement separate terminal/conversation title fields, OSC capture with retained state, Codex name-index support, and consistent rename refresh for all capable providers.
3. Move normalized lifecycle ownership out of React, with explicit provider capabilities and stale/unknown observation state. Preserve the existing native TUIs; this does not require converting every terminal into a chat UI.
4. Add missing provider adapters and qualify orchestration against the common lifecycle contract.

Acceptance scenarios must include: two same-folder panes; parallel children; rename before and after binding; title changes while hidden; switch away before first discovery; late first prompt; quiet long-running tool; approval prompts; empty/menu Enter; interrupt then immediately submit; delayed old completion; CLI exit while the shell remains; close during launch; hook unavailable/untrusted; UTF-8/OSC sequences split between chunks. Run the supported cases for each provider rather than assuming parity from one passing implementation.

## Verification and limits

Parent review covered the renderer, metadata parser, event transport, lifecycle handlers, and the actual independent review artifacts, then checked the combined status/title dependency chain.

Passed: TypeScript typecheck and 13 existing smoke suites: frontend attention, session launch, terminal output, workspace, pane split; backend CLI probe, launch cwd, Codex/Claude/Kimi/Kimi-custom/Qwen discovery, and agent telemetry.

Four additional diagnostics execute the real functions with synthetic state or virtual filesystem data. The parent inspected and ran each successfully:

- `.tmp/terminal-integration-audit/status-repro.cjs`
- `.tmp/terminal-integration-audit/renderer-repro.cjs`
- `.tmp/terminal-integration-audit/telemetry-repro.cjs`
- `.tmp/terminal-integration-audit/backend-repro.cjs`

These diagnostics assert the presence of current defects; they are evidence, not regression tests for a fix. They are local ignored artifacts. The existing suites passing alongside them demonstrates missing behavior coverage: several checks exercise pure helpers or source patterns without the problematic event sequences.

No live TUI/visual end-to-end run or paid agent request was performed. Vendor protocol evidence comes from the repository snapshot, not a claim of latest upstream compatibility. The local presence probe found Codex, Claude, Cursor, OpenCode, Kimi, and Qwen; Gemini and Aider were absent. Presence alone does not verify launchability, authentication, or hooks.
