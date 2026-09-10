# Lina Terminal Agent Guide

Lina Terminal is an Electron + React desktop workspace for running local terminals and coding agents side by side.

## Docs Index

- `docs/release-0.1.115-review.md` - Terminal resource and Orchestrator release, closure-fixture startup repair, CI diagnostics and acceptance boundaries.
- `docs/release-0.1.114-review.md` - Unpublished terminal resource candidate, local acceptance and failed CI closure setup; immutable tag retained.

- `docs/orchestrator-historical-errors-crosscheck-2026-09-10.md` - Direct saved-history/log/installed-package reconciliation: recovered and failed requests, shipped versus source-only repairs, unverifiable older causes and diagnostic-retention gap.

- `docs/orchestrator-repair-plan-2026-09-10.md` - Complete repair roadmap reconciling capability/performance audits; completed stale-code cleanup and current-schema readiness fix, dependencies, migration rules and acceptance criteria.

- `docs/orchestrator-capability-audit-2026-09-10.md` - Capability audit: repaired stale reads, workspace counts and configuration discovery; live-model factual failures, request-control and child-approval gaps, acceptance and remaining risks.

- `docs/performance-orchestrator-overhaul-2026-09-10.md` - Implemented terminal retirement, batched observation, transport pressure, activity-only publications, metadata and Orchestrator grounding; measured improvements, acceptance and remaining limits.

- `docs/orchestrator-inactive-close-investigation-2026-09-10.md` - Wrong inactive-terminal closure, recent interpretation errors, conditional-close review and runtime/input guards, verification and remaining model-answer limits.

- `docs/performance-memory-audit-2026-09-10.md` - RAM and performance investigation: reproduced closed-PTY buffer retention, observer backlog, output-driven history copying, renderer and process lifecycle risks, offline probes and prioritized recommendations.

- `docs/release-0.1.113-review.md` - Claude child status and terminal scrollback release, acceptance checks and installation boundary.

- `docs/claude-terminal-status-investigation.md` - September 10 Claude status audit and child settlement repair: native task reconciliation, preserved background work, remaining child-approval gap, installed evidence and Windows/Node regressions.

- `docs/release-0.1.112-review.md` - Final native Windows 8.3 fixture repair and early CI gate for publishing the performance/harness overhaul; retained failed tags and runtime verification.

- `docs/release-0.1.111-review.md` - Publication of the performance/harness overhaul after repairing the Windows canonical-path test fixture; immutable failed-tag history and verification boundary.

- `docs/release-0.1.110-review.md` - Orchestrator overhaul and performance release: measured history-copying and polling costs, control readers, fullscreen review, acceptance and deployment boundary.

- `docs/orchestrator-harness-overhaul.md` - Implemented semantic planning/execution separation, inspection goal loop, workspace/file navigation, safe project removal and retry, acceptance evidence and remaining boundaries.

- `docs/orchestrator-architecture-review.md` - September 9 evening retry-composition failure, interpreter separation, spending-limit repair, remaining ownership boundaries and live-model verification limits.

- `docs/release-0.1.109-review.md` - Task-ownership release, full local/package acceptance, test fixture readiness repairs, remaining model limits and installation boundary.

- `docs/orchestrator-task-ownership-review.md` - September 9 wrong-recipient investigation, existing-conversation selection evidence, new-work versus continuation routing, verification and remaining live-model limits.

- `docs/release-0.1.106-review.md` - Current-conversation repairs and listening-cue release, source/package acceptance, harness limitations and installation boundary.

- `docs/orchestrator-conversation-errors-2026-09-09.md` - Current conversation failures, history context repair, specific voice feedback, startup recovery and observed handoffs, with acceptance and installed-build boundaries.

- `docs/release-0.1.105-review.md` - September 9 release audit, pending activity, restart identity and race repairs, expanded release gates, and packaged verification.

- `docs/orchestrator-recovery-review.md` - September 9 close-scope and process verification, truthful continuation/routing, model safeguards, complete source/package acceptance, and installation boundary.

- `docs/codex-activity-and-hook-trust-plan.md` - Default trust for Lina's exact Codex hooks, pending-input activity display repair, acceptance checks and installed-build boundaries.

- `docs/release-0.1.104-review.md` - September 8 repeated bug sweeps, terminal wheel and voice repairs, independent verification, packaged acceptance and evidence boundaries.

- `docs/orchestrator-openrouter-compatibility.md` - Forced-tool timeout investigation, live model comparisons, automatic tool selection fix, capability-aware options, diagnostics, and installed/source verification boundaries.

- `docs/orchestrator-terminal-navigation.md` - Provider-specific native commands, usage versus quota meanings, menu controls, source evidence and installed-build boundaries.

- `docs/orchestrator-efficiency-review.md` - Tool inventory and knowledge audit, batching and unfinished-work fixes, measured context savings, and the design path for goal evaluation.

- `docs/orchestrator-queued-prompts-investigation.md` - September 8 queue investigation: project admission versus terminal delivery, unavailable-target selection, busy Codex queue behavior, duplicate recovery risk, and reproduction evidence.

- `docs/orchestrator-cohesion-review.md` - Consolidated harness audits and latest Grok/status/resume review: lifecycle, repaired input/scheduling/history/voice gaps, native identity limits and combined acceptance. `docs/orchestrator-cohesion-second-pass.md` retains historical second-pass evidence.

- `docs/orchestrator-routing-deep-dive.md` - Automatic task assignment implementation and historical investigation: task-to-conversation ownership, reuse/create decisions, verified creation and submission, scheduling, context efficiency, and acceptance criteria.

- `docs/orchestrator-tasks.md` - Request-owned conversations, immediate queueing, independent execution, result dependencies, dynamic targets, cancellation, saved history, and voice clarification routing.

- `docs/orchestrator-controls.md` - Current semantic Orchestrator contract: natural user goals, scoped per-terminal commands, unfinished work, supplied answers, native text/key controls, private diagnostics, and verification boundaries.

- `docs/orchestrator-dashboard.md` - Clear-glass session visualization, truthful request activity, stable motion/recency, and verification.

- `docs/orchestrator-voice-deep-dive.md` - Current voice architecture and reliability audit: local/cloud stages, recording and interruption rules, repaired defects, remaining limits, installed/source version boundaries, diagnostics, privacy, and verification.

- `docs/orchestrator-context-and-audio.md` - Progressive output/history access, model-only context budgets, and bundled OpenRouter error announcements.

- `docs/orchestrator-harness-review.md` - Single relay conversation, title-based discovery, tool authority, identity/cancellation edge cases, and verification boundaries.

- `docs/orchestrator.md` - User-command relay, OpenRouter setup, voice overlay, observation/action contracts, saved setups, handoffs, and verification limits.

- `docs/voice-push-to-talk.md` - Space and mouse hold gestures, focus guards, automatic-recording handover, capture flushing, and verification.
- `docs/voice-handsfree.md` - Optional account-free Hey Lina activation, pretrained CPU models, automatic answers, capture fencing, fallback, and verification.
- `docs/frontend.md` - React renderer files, UI state, terminal panes, layout board, and styling.
- `docs/backend.md` - Electron main process, PTY host, and agent thread discovery files.
- `docs/preload.md` - Context bridge and IPC surface exposed to the renderer.
- `docs/terminal-runtime.md` - Standalone terminal identity, titles, progress, generation-scoped lifecycle, Gemini adapter, and board placement/sizing behavior.
- `docs/terminal-status-support.md` - Provider status evidence, child/background observation, provisional completion limits and shared display behavior.
- `docs/grok-build.md` - Grok Build launch, native hooks, status, conversation discovery/history, and installed-version verification.
- `docs/scripts.md` - Development, smoke test, and screenshot helper scripts.
- `docs/windows-release.md` - Windows installer, GitHub Releases deployment, update behavior, and signing status.
- `docs/fusion-terminal.md` - Shipped two-model Fusion architecture (Opus orchestrator + embedded per-pane Codex executor, the adapter, approval/verifier loop).
- `docs/openfusion.md` - Open Fusion chat mode: Lina Terminal-native chat pane over a headless per-pane `opencode serve` (no OpenCode TUI), full data ownership (threads, credentials, and config in an app-owned OpenCode home under userData via XDG overrides — the user's global OpenCode install is never read or written), pane-scoped OpenCode config, no default models (first-run gate: connect a provider, then pick Brain/Executor), model pickers and slash commands, in-pane permission approvals, OpenCode-parity provider auth (method select, prompt fields, API key + metadata, browser OAuth, unknown provider ids refused), hard read-only investigator subagent, and planner-owned review gate.
- `docs/fusion-and-open-fusion.md` - Product description of Fusion and Open Fusion in one file: what each feature is (Claude+Codex vs any two chosen models), who each is best for, an at-a-glance comparison, and what they share; points to `docs/fusion-terminal.md` and `docs/openfusion.md` for the technical deep-dives.
- `docs/fusion-unification.md` - Analysis + verified design path for making Fusion read/behave as one unified agent (perceptual vs cognitive unity, seams, guarantee-preserving levers).
- `docs/fusion-unification-handoff.md` - Pick-up note for the unification work: status, the exact first change, gotchas, and how to verify.
- `docs/voice-dictation.md` - Proposed speech-to-text design sketch (not implemented): provider-agnostic mic→text→inject feature, engine options, open questions.
- `docs/vendor.md` - External reference material kept outside active app source.
- `docs/runtime-artifacts.md` - Generated folders, outputs, and cleanup expectations.
