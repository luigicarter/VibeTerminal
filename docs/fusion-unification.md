# Fusion — Acting as One Unified Agent

> **Status: analysis / design note (not yet implemented).**
> Companion to [`fusion-terminal.md`](fusion-terminal.md), which documents the
> shipped two-model architecture. This note analyzes how Fusion *orchestrates*
> today and lays out a verified, guarantee-preserving path to making it **read
> and behave as one agent** instead of an Opus that narrates handing work to a
> Codex. Every code-level lever below was adversarially checked against the real
> source; none were found infeasible (18 feasible-with-correction, 5 feasible
> as-stated). Line numbers drift — **re-anchor by symbol when implementing.**

## TL;DR

Fusion is a two-model **router→executor** pipeline (Claude Opus/Sonnet 5 plans/reviews read-only; Codex GPT-5.5 writes all code, owns execution, and self-verifies) presented behind one
pane. It already *intends* to be one agent, but leaks the split at nearly every
surface. **~80% of the "two agents" feeling is presentation, not architecture**,
and can be removed with wording/label/color changes that touch the hard guarantee
**byte-for-byte not at all**. The remaining 20% is real structural memory split
(Codex gets a bare task string; resume starts a blank Codex thread) and takes more
work but is the difference between "one voice" and "one mind."

There are two distinct senses of "unified," and they should be treated as
separate tiers:

- **Sense A — perceptual unity (one voice).** Cheap, low-risk, high payoff.
- **Sense B — cognitive unity (one memory / one mind).** Deeper, real cost.

---

## 1. How Fusion orchestrates today

Fusion is **not one agent** under the hood — it is a strict two-model loop:

```
You ──▶ Claude Opus/Sonnet 5 (headless `claude`, read + UI-write tools, Bash blocked)
            │  speaks prose + makes every tool call
            │  optional: mcp__fusion-codex__codex_investigate(task)
            │  mcp__fusion-codex__codex_implement(task)
            ▼
        fusion-adapter.cjs   (MCP server north / JSON-RPC client south)
            │  thread/start + turn/start(investigation or verifier task)
            ▼
        codex app-server (GPT-5.5)  ← edits, runs tests, fixes, refactors
            │  streams items; parks only exceptional requests/questions
            ▼
        verdict: FUSION_VERDICT_JSON {goalReached, bugsFound,
                                      missingRequirements, nextAction}
```

### The mechanics, end to end

1. **Launch & lock** — `main.cjs` `fusion-chat:start` →
   `fusionChatHost.buildClaudeArgs`. Claude is spawned headless with `--tools`
   limiting the built-in surface to `Read`, `Glob`, and `Grep`,
   `--allowedTools` exposing those plus the Fusion bridge,
   `--disallowedTools Bash,Edit,Write,NotebookEdit`, and
   `--strict-mcp-config`. Claude is read-only: ALL code writing plus every
   command, test, build, debug run, screenshot, browser action,
   image-generation task, and verification pass routes through
   `codex_implement`. This is the structural heart of Fusion.

2. **The delegation loop** — `fusion-adapter.cjs` `codexInvestigate` /
   `codexImplement`. The adapter owns one private `codex app-server` child over
   stdio. `codex_investigate` runs read-only scouting and returns findings/files
   for Claude's planning under a `readOnly` turn sandbox. Each `codex_implement`
   wraps the task in a **verifier contract** (`buildCodexVerifierTask` — *"You are
   Codex GPT-5.5…"*) demanding a single-line JSON verdict, then streams Codex's
   items back to the renderer via the best-effort telemetry callback. Since
   2026-07-06 the contract also mandates visual verification: when the
   delegated outcome is visual (UI/styling, rendered pages, images, charts,
   terminal UI), Codex must render it, capture a screenshot/image file,
   actually view the image, and report what it observed — code reading and
   tests alone are declared insufficient, and an unviewable result goes into
   `missingRequirements` instead of being passed off as checked.

3. **Exceptional decision parking** — `handleServerRequest` → `needs_decision`.
   Codex now runs with full workspace access and no routine command approvals,
   so read/edit/debug loops should not bounce through Opus. If Codex still asks
   a question or surfaces an exceptional permission request, the adapter parks it
   and returns `{status:"needs_decision", pendingId}` to Opus, who decides and
   calls `codex_respond`.

4. **The completion gate** — `normalizeVerifierVerdict`, `completedTurnResult`.
   The verdict is parsed **fail-closed**: missing / malformed / contradictory →
   `goalReached:false, nextAction:"continue"`. The system prompt instructs Opus
   to continue/redelegate until the verdict says done.

5. **Goals as long-horizon state** — `codex_goal_*`. Codex's native per-thread
   goal tracks the standing objective; the adapter auto-creates a fallback goal
   and syncs `complete` only after a true done verdict (it never overwrites
   Codex-managed `blocked`/`usageLimited`/`budgetLimited`).

6. **Control plane** — `startControlServer` (`/steer`, `/interrupt`, `/stop`,
   `127.0.0.1`, session-id-scoped) plus the host's `interrupt`/`steer`/`stop`.
   One Stop/Esc fans out to *both* Opus (stream-json `control_request`) and Codex
   (`turn/interrupt`).

### What makes the split a *guarantee*, not a suggestion

Three mechanisms, in **decreasing** order of how strongly they are enforced:

| Mechanism | Enforcement | Where |
|---|---|---|
| Claude UI-write / Codex owns execution, images, browser actions, and verification | **Physical** (harness tool lock) | `main.cjs` Fusion tool helpers + `disallowedTools='Bash'` + `--tools`/`--strict-mcp-config`; `fusionChatHost.buildClaudeArgs` |
| Verdict value cannot falsely report success | **Structural** (fail-closed parser) | `fusion-adapter.cjs` `normalizeVerifierVerdict` |
| Opus *honors* `nextAction:"continue"` | **Behavioral only** (prompt) | `buildFusionSystemPrompt` completion-gate copy |

> ⚠️ The third row is the weak link (see [§5](#5-two-warnings)). Nothing
> structurally stops Claude from telling the user "all done" while the verdict says
> `continue`. Any unification work must **not** make this worse.

---

## 2. Why it doesn't yet feel like one agent — the seams

The design intends unity (system prompt: *"Present yourself as one Fusion
agent"*; empty state: *"one agent for planning, coding, and review"*) but leaks
the two-model nature at every surface. 37 seams were found across 5 subsystems;
they cluster into four layers:

| Layer | The tell | Where |
|---|---|---|
| **Identity / voice** | The visible name **flips mid-task** between `"Fusion - Claude Code"` and `"Fusion - Codex"`; the header chip and the "X working…" spinner change speaker; the transcript alternates purple↔orange as two voices | `FusionChatPane.tsx` `fusionRoleLabel`, author ternary, `activeRole`; `styles.css` `.chat-opus`/`.chat-codex` |
| **System prompt** | **Self-contradictory.** ~90% frames Opus as "the orchestrator" with "your counterpart, Codex GPT-5.5," with separate `## Your scope` / `## Codex's scope` / `## How to delegate` sections; a single late paragraph says "present as one agent." The dominant scaffolding biases Opus toward hand-off narration | `agentTelemetry.cjs` `buildFusionSystemPrompt` |
| **Protocol leakage** | Bridge mechanics surface as user-visible text: `"implementation handoff · …"`, grader verdicts `"verified / needs follow-up / needs input"`, `"Codex wants to run…"`, and on the failure path `"Codex bridge stalled"`, `"Codex app-server exited"`, `"Codex turn was interrupted"` | adapter `approvalDetail` + error strings; renderer `formatCodexBridgeResult` |
| **Structural memory split** | Codex gets only the bare task string (*"Codex does not share your context"*); returns only a summary + file **paths**; on resume Opus restores via `--resume` but Codex starts a **blank thread** (`ensureThread` always `thread/start`) — the agent loses half its memory; the split is even exposed as `/opus` vs `/codex` config | adapter `codexImplement`/`ensureThread`; UI slash surface |

### Seams no current lever fully addresses (call them out before scoping)

- **Codex/bridge-named *error & timeout* strings** (`missingVerifierVerdict`,
  idle-stall, child-exit, interrupted, "stdin not writable"). These hit at the
  *worst* moment for the illusion — when the user is paying attention — and are
  pure wording with zero guarantee risk. Highest-value omission after the labels.
- **Transcript ordering + silent activity drop.** The Codex side-channel travels
  adapter → **fire-and-forget** HTTP (`postTelemetry`, 1s timeout, swallowed
  errors) → main → host stdin, while Opus prose goes straight down claude stdout.
  There is **no sequence/timestamp key**, so chips interleave jittery against
  Opus prose, and a dropped POST silently erases Codex's narration *while Opus's
  eventual tool-result still lands* — the transcript then claims work with no
  visible trace. This is arguably the deepest *coherence* seam.
- **Steer-text divergence.** A mid-turn steer reaches both halves out-of-band but
  is not recorded on the turn, so Opus's account can omit instructions it
  actually processed.

---

## 3. Sense A — Perceptual unity (one voice)

Pure presentation re-voicing. **All verified feasible; all preserve the guarantee
byte-for-byte** because they never touch the tool lock or the verdict parser.

| # | Lever | Files (anchor by symbol) | Effort | Notes |
|---|---|---|---|---|
| A1 | **Collapse role→speaker to one "Fusion"** — author labels, header chip, busy spinner all read "Fusion"; unify the purple/orange CSS. *Keep* internal `role`/`activeRole` state — `needs_decision` routing depends on it; only the displayed name collapses. | `FusionChatPane.tsx` (`fusionRoleLabel`, author ternary, header chip, spinner), `styles.css` (`.chat-opus`/`.chat-codex`, dead `.fusion-chip-codex`) | **S** | Core rated **feasible as-stated**. |
| A2 | **Re-voice every Codex-named string to neutral first-person** — `"Codex wants to run X"`→`"Run X?"`, **and the failure-path strings**. | `fusion-adapter.cjs` (`approvalDetail`, error/timeout strings) | **S** | Wording only. |
| A3 | **Rewrite the system prompt to a single first-person identity** — lead with "You are Fusion, one agent," demote Codex to an internal tool, reframe scope sections as neutral tool docs. | `agentTelemetry.cjs` `buildFusionSystemPrompt` | **M** | ⚠️ Keep the *lock/gate* sentences verbatim. |
| A4 | **Demote verdict/goal JSON and the dual-model settings line to Details-only** (`verbose` toggle already exists); keep `needs_decision`/`failed` visible. | `FusionChatPane.tsx` (`formatCodexBridgeResult`, settings line) | **M** | Verdict still flows to Opus + gate. |
| A5 | **Mask the hand-off latency** with a phase-aware caption ("Building…" → "Running npm test…" → "Editing foo.ts…") driven off the latest event. | `FusionChatPane.tsx` busy spinner + derived `phase` | **S** | Round-trip reads as thinking, not a hang. |
| A6 | **(Optional) Re-voice the bridge result** to first-person outcome — keep `goalReached===true && nextAction==='done'` gating the word "Done." | `FusionChatPane.tsx` `formatCodexBridgeResult` | **S** | Don't loosen the gate condition. |

---

## 4. Sense B — Cognitive unity (one mind, one memory)

What makes Fusion actually *behave* as one agent rather than two processes
passing a string. Every move touches only the **input context** fed to Codex or
the **return payload** to Opus — never the tool lock or the verdict contract — so
the guarantee is preserved. The dominant cost is **tokens/plumbing**, so every
injected/returned block must be **hard-capped**.

| # | Lever | Files (anchor by symbol) | Effort | Notes |
|---|---|---|---|---|
| B1 | **Auto-carry working memory into every Codex turn** — snapshot the prior-turn summary + objective into a capped `## Continuity` block prepended in `buildCodexVerifierTask`. Zero new transport. | `fusion-adapter.cjs` (`codexImplement`, `resetTurnBuffers`, `buildCodexVerifierTask`) | **M** | Cap ~800 chars. |
| B2 | **Optional `context` arg on `codex_implement`** for Opus's architectural intent + read-findings; delete the "Codex does not share your context" caveat once B1/B3 make it false. | `fusion-adapter.cjs` (TOOLS schema, `codexImplement`), `agentTelemetry.cjs` prompt | **M** | Opus passes context as data; still read-only. |
| B3 | **Host-driven shared-context push** — the host owns the merged transcript and sees every Opus Read/Grep/Glob; accumulate a digest (intent + files inspected) and POST it to the adapter via a new awaited `/context` control endpoint (reuse the `/steer` transport, **not** the best-effort 1s POST). | `fusionChatHost.cjs`, `main.cjs`, `agentTelemetry.cjs`, `fusion-adapter.cjs` `startControlServer` | **M** | Closes the file-read seam automatically. |
| B4 | **Return Codex's real work product** (size-capped diffs + command exits) to Opus, not just file paths, so review is grounded in what actually happened. Render as an expandable diff behind Details. | `fusion-adapter.cjs` (`accumulate`, `completedTurnResult`), `FusionChatPane.tsx` | **M** | Cap diff bytes; redact secrets. |
| B5 | **Unify resume** — persist the Codex `threadId` + goal and rejoin via `thread/resume` (a verified app-server method) instead of always `thread/start`. The *deepest* memory seam. | `fusion-adapter.cjs` `ensureThread`, `main.cjs` persist, `agentTelemetry.cjs` env, `fusionChatHost.cjs` | **L** | Must degrade to a fresh thread with a visible "context reset" note on failure — never silent half-memory. Persist via `AgentThreadRef`/`AgentSession` in `types.ts` (like the Claude `resumeId`), not an in-memory map. |
| B6 | **Reframe the goal store as one shared working memory** in copy (tool descriptions + prompt) — it already *is* the single source of truth; only the "Codex's native goal" vocabulary leaks. | `fusion-adapter.cjs` goal tool descriptions, `agentTelemetry.cjs` prompt | **S** | Pure wording. |
| B7 | **(Optional, guarded) internal verify→fix loop** — auto-retry mechanical `bugsFound` fixes inside the adapter (low cap) so the most common round-trip disappears; bubble re-scopes / `ask_human` to Opus. | `fusion-adapter.cjs` `codexImplement` | **M** | See cost-loop warning in §5. |

---

## 5. Two warnings

1. **The lock and the gate are not equally strong.** `disallowedTools` is
   *physically* enforced; the verifier **gate is behavioral only**.
   `normalizeVerifierVerdict` fail-closes the verdict *value*, but nothing stops
   Opus from saying "all done" while the verdict says `continue`. A unified agent
   that silently swallows "keep going" is **worse** than two visible ones.
   Therefore: keep the verdict **one click away** (Details, A4) rather than fully
   buried, and in the prompt rewrite (A3) keep the gate language —
   *"Bash is blocked"*, *"ALL execution work goes through Codex"*, and *"Always let Codex's verifier verdict gate completion"* — **verbatim**. (The fusion-launch smoke test
   independently demands the `goalReached:false` and "Codex verifier override"
   literals survive, which partially backstops this.)

2. **Do not reintroduce fragile approval automation.** Fusion now avoids the
   old approval fight by launching Codex with `approvalPolicy:"never"` and full
   workspace access. If a future mode brings approvals back, do not auto-clear
   "read-only" commands with regex/argv-name checks: `params.command` can be an
   argv array, so an `argv[0]` allowlist is fooled by argv-form mutators that
   need no shell metacharacters (`find … -exec`, `xargs`,
   `git -c core.sshCommand=…`, `rg --pre`, anything with `-o/--output`). Use a
   closed safelist with vetted arguments and explicit reject rules, or keep the
   request parked for Opus/human review.

3. **(Loop cost, B7)** The internal verify→fix loop relies on
   `currentGoal.tokenBudget` as a backstop, but `tokensUsed` is **stale** (only
   refreshed via `thread/goal/updated`), so the budget check is decorative — the
   **iteration cap is the only real guard**. Keep it low and short-circuit on
   `status!=='completed'` (a parked approval mid-loop has no verdict).

---

## 6. Recommended sequence

1. **Start here (highest leverage, lowest risk): A1 + A2.** The one-voice
   collapse plus the error-string re-voice kill the two loudest "two engines"
   tells (the live name-flip and the failure text), are wording/CSS only, and are
   fully reversible.
   - ⚠️ **Test coupling:** `scripts/frontend/attention-smoke.cjs` hard-asserts the
     literal strings `"Fusion - Claude Code"`, `"Fusion - Codex"`, and
     `activeRoleLabel`. Relax that guard **in the same change** or the collapse
     breaks the smoke test.
2. **Rest of Sense A:** A3 (prompt), A4 (JSON→Details), A5 (latency caption),
   A6 (result wording).
3. **Sense B for true continuity:** B1 (working-memory injection) → B4 (diff
   return) → B6 (goal copy) → B3 (host context push) → B5 (unified resume). B7
   last and guarded.

## 7. Implementation caveats

- **Line numbers drift.** The feasibility pass found nearly every frontend
  citation off by ~70–170 lines (e.g. `formatCodexBridgeResult`, the header chip,
  `activeRoleLabel`). **Re-anchor by symbol, not line.**
- **Provenance is a tradeoff, not a loss.** Collapsing author + color removes
  at-a-glance "which model" provenance. Mitigate by keeping the `role` field on
  `ChatMessage` and the `chat-${role}` className so the existing `verbose`/Details
  toggle still exposes it on demand; `/models` still prints the config.
- **Caps everywhere in Sense B.** Continuity/context preambles and returned diffs
  must be byte-capped or they blow Opus's/Codex's context windows and raise cost.
  A *wrong* prior-turn summary is worse than none — keep shared memory a short
  rolling digest, not full history.

---

## Appendix — provenance of this note

Produced by a 33-agent analysis workflow: 5 parallel subsystem deep-reads → 4
independent unification blueprints (persona/voice, transcript/UX, context/memory,
control-flow) → 23 adversarial feasibility checks against the real source → a
completeness critic. Verdict tally: **5 feasible as-stated, 18 feasible with
correction, 0 infeasible.** Cross-checked against first-hand reads of
`fusion-adapter.cjs`, `fusionChatHost.cjs`, `main.cjs` (`fusion-chat:*`),
`agentTelemetry.cjs` (`buildFusionSystemPrompt`, `prepareFusionFiles`), and
`FusionChatPane.tsx`.
