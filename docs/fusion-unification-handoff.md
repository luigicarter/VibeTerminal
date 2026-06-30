# Handoff — Fusion "one unified agent" work

> **For whoever picks this up next** (teammate or fresh agent). Read this first,
> then [`fusion-unification.md`](fusion-unification.md) for the full analysis and
> [`fusion-terminal.md`](fusion-terminal.md) for the shipped architecture.

## Status

- **Analysis: done and verified.** 33-agent workflow + first-hand reads.
  Conclusion: ~80% of the "two agents" feeling is *presentation*, removable with
  zero risk to the hard guarantee; the rest is a real structural memory split.
- **Code: nothing implemented yet.** No behavioral changes have been made. The
  working tree only contains the prior, unrelated `fusion-adapter.cjs` /
  `fusion-adapter-smoke.cjs` edits that were already in progress before this
  analysis.
- **Decision still open:** how far to go — Sense A only (one voice), or A + B
  (one memory). See "Open decisions" below.

## The mental model (90-second version)

Fusion = Opus 4.8 (read-only planner) → `codex_implement` → embedded Codex
GPT-5.5 (makes every edit, self-verifies with a `FUSION_VERDICT_JSON` gate). The
two-model split is real and **deliberately enforced** (Opus has no Edit/Write/Bash
tools). The goal is **not** to merge the models — it's to stop the seams (label
flips, "Codex wants to…" strings, JSON verdicts, blank-thread resume) from
leaking the split to the user, **without** weakening the lock or the verdict gate.

## Do this first (the recommended starting PR)

**Tier 1 = levers A1 + A2 from the analysis doc.** Highest payoff, lowest risk,
fully reversible, presentation-only.

1. **A1 — collapse role→speaker to one "Fusion."** In `FusionChatPane.tsx`:
   `fusionRoleLabel` returns a constant `"Fusion"`; the author ternary maps both
   `opus` and `codex` to `"Fusion"`; the header chip and the busy spinner read
   `"Fusion"` and drop the `activeRole`-keyed color class. In `styles.css`: unify
   `.chat-opus`/`.chat-codex` author + tool-author colors; delete the dead
   `.fusion-chip-codex` rule.
   - **Keep** the internal `role` field and `activeRole` state — `needs_decision`
     routing and the `chat-${role}` className depend on them. Only the *displayed*
     name/color collapses.
2. **A2 — re-voice Codex-named strings** in `fusion-adapter.cjs`: `approvalDetail`
   (`"Codex wants to run X"` → `"Run X?"`, etc.) **and the failure-path strings**
   (`missingVerifierVerdict`, idle-stall, `"codex app-server exited"`,
   `"Codex turn was interrupted"`, "stdin not writable"). Wording only.

### ⚠️ Don't miss this
`scripts/frontend/attention-smoke.cjs` **hard-asserts** the literal strings
`"Fusion - Claude Code"`, `"Fusion - Codex"`, and `activeRoleLabel`. Relax that
guard **in the same change** or the smoke test fails.

## Guardrails (do not violate)

1. **Never add an edit/shell/image-generation/browser-control tool to Opus.**
   The allowlist in `main.cjs`, backed by `disallowedTools='Edit,Write,Bash'`,
   is the physical guarantee. All mutation and image/browser execution stays in
   `codex_implement`.
2. **Don't soften the gate language** in the system prompt rewrite (A3). Keep
   *"EVERY change MUST go through codex_implement"* and *"let the verifier verdict
   gate completion"* verbatim — the verdict gate is **behavioral only**, so the
   prompt is the only thing holding it.
3. **Keep the verdict one click away** (Details), not fully buried — a human needs
   to be able to notice when Opus ignores a `continue`.
4. **No naive command auto-approval.** The argv-array bypass (`find -exec`,
   `git -c core.sshCommand=…`, `--output` flags) makes a `argv[0]` allowlist
   unsafe. Out of scope for Tier 1.

## How to verify a change

- `npm run smoke:backend:fusion-adapter` — adapter loop + verifier helpers.
- `npm run smoke:frontend:attention` (the test that pins the role labels — expect
  to update it for A1).
- Typecheck + build.
- Manual: a live turn needs `claude login` + `codex login`; launch a Fusion pane
  and confirm the transcript reads as one "Fusion" voice with no mid-turn name
  flip. (See `fusion-terminal.md` "live turn" notes.)

## Open decisions for the owner

1. **Scope:** ship Sense A (one voice) alone, or commit to Sense B (shared memory
   + unified resume) too? A is days; B5 (unified resume) alone is the one L-effort
   item and needs `types.ts` `AgentThreadRef`/`AgentSession` persistence.
2. **Provenance default:** is hiding model provenance behind the `verbose`/Details
   toggle acceptable, or should a subtle non-named gutter glyph remain in the
   default view?
3. **Verdict visibility:** Details-only (recommended) vs. a always-visible
   one-line outcome chip.

## Key files (anchor by symbol — line numbers in the analysis doc have drifted)

| Concern | File · symbol |
|---|---|
| Launch + tool lock | `backend/main.cjs` `fusion-chat:start`; `backend/fusionChatHost.cjs` `buildClaudeArgs` |
| System prompt / persona | `backend/agentTelemetry.cjs` `buildFusionSystemPrompt`, `prepareFusionFiles` |
| Delegation loop + verdict gate | `backend/fusion-adapter.cjs` `codexImplement`, `buildCodexVerifierTask`, `normalizeVerifierVerdict`, `handleServerRequest`, `approvalDetail` |
| Renderer / one-voice | `frontend/components/FusionChatPane.tsx` `fusionRoleLabel`, author ternary, `formatCodexBridgeResult`; `frontend/styles.css` `.chat-opus`/`.chat-codex` |
| Test coupling | `scripts/frontend/attention-smoke.cjs` (role-label asserts) |
