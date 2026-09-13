# Lina Terminal Agent Guide

Lina Terminal is an Electron + React desktop workspace for running local terminals and coding agents side by side.

## Repository layout

- Desktop source, vendor resources, and app-specific scripts live in `apps/desktop`.
- Website frontend/API and user-guide content live in `apps/website`.
- The Expo/React Native iOS and Android app lives in `apps/mobile`.
- The independent Bun + TypeScript account backend lives in `apps/server`: login, account/tier management, activity intake, database, and monitoring. It is locally verified; live Google deployment is pending.
- Shared brand source lives in `packages/brand`; root scripts synchronize exports.
- Engineering docs stay in root `docs`. Historical desktop paths in these docs are relative to `apps/desktop`.
- Each app owns its dependency lockfile and build output. Root npm scripts forward to the appropriate app.
- Local root-level compatibility junctions are ignored; edit the canonical `apps/` paths.

## Required directory ownership for agents

- Before creating or moving files, read this guide and the destination app's
  `AGENTS.md`. Place each change in the app that owns its responsibility.
- All hosted account-server implementation belongs in `apps/server`: login and
  session services, PostgreSQL schema/migrations, account/tier policy, activity
  intake, administration APIs, monitoring, server tests, and VM deployment files.
- `apps/desktop/backend` owns Electron, local terminals/agents, and the desktop's
  local mobile bridge. `apps/website/backend` owns marketing APIs. Neither is a
  location for the hosted account server.
- Keep client screens, HTTPS clients, and client-side activity emitters with
  their desktop, website, or mobile app. Clients must not import server runtime
  code or receive database credentials, migration code, or server dependencies.
- Keep each app's dependencies, lockfile, scripts, fixtures, and build output in
  its own folder. Root scripts and `.github/workflows` may coordinate apps;
  shared brand assets belong in `packages/brand`, engineering docs in `docs`.
- Do not create duplicate root-level source folders or use compatibility
  junctions as canonical edit paths. Update ownership documentation when a
  responsibility actually moves, preserving unrelated work in this checkout.
- Treat the [repository layout](docs/repository-layout.md) and the owning app's
  guide as required placement rules for future implementation and refactoring.

## Docs Index

- `docs/release-0.1.122-review.md` - The 0.1.122 release: Orchestrator first-prompt readiness, idle-pane reuse, answer-plus-new-work replies, the bundled Codex 0.154.0 pin and the Chats-only-from-Chats rule, with three QA-harness repairs found during review (packaged model routing, the drag-preview sample, a hex sentinel that collided with a generated id), local gate and first packaged 0.154.0 acceptance evidence, and publication status.

- `docs/orchestrator-terminal-readiness-2026-09-13.md` - Why the Orchestrator stopped getting first prompts into panes on 0.1.121 and what changed: the stale Claude footer rule replaced by recorded-screen recognizers for every PTY provider, startup-screen reporting and the folder-trust answer extended to all of them, never-prompted panes and panes owned by a cancelled task made reusable, mixed answer-plus-new-work replies represented per grant, a runnable provider-startup probe, and a per-provider verified/unverified readiness table.

- `docs/codex-bundle-0.154-2026-09-13.md` - Bundled Codex pin 0.144.0 → 0.154.0: the user's 0.154-written `[agents]` config the old binary cannot parse, per-surface impact (pane vs Fusion app-server vs `debug models`), the single `vendor/codex-appserver` pin and the coherent Open Codex/Codex Web bundles, additive app-server protocol drift, effort/model catalog changes, and what was and was not verified.

- `docs/release-0.1.121-review.md` - Complete-work publication after fixing a reproduced Windows atomic-save lock failure; bounded retries, stress/regression checks, retained unpublished candidates and verified publication evidence.

- `docs/release-0.1.120-review.md` - Final complete-work publication, compact-sidebar warning-space repair, unchanged unpublished 0.1.118/0.1.119 tags, acceptance and public update-feed verification.

- `docs/release-0.1.119-review.md` - Publication of the complete pending work after correcting the clean-runner workspace fixture race and mobile mock dependency ownership; retained unpublished 0.1.118 tag, package/CI acceptance and publication evidence.

- `docs/release-0.1.118-review.md` - Complete pending-work release: terminal Chats/recovery, Orchestrator overhaul, read-only phone bridge, mobile/server/account-preview source, release-review fixes, all-app acceptance and installer/publication evidence.

- `docs/chat-section-implementation-2026-09-13.md` - Implemented terminal-format Chats directly below Projects: durable SQLite catalog/workspace and app-owned drafts, exact native resume, private Codex Web history, shutdown/crash/renderer-reload recovery, bounded history copies and backups, reviewed bugs, source/package verification and prioritized remaining edge cases. Published in v0.1.121; installation remains explicit.

- `docs/chat-section-plan-2026-09-13.md` - Broader Chats design and recovery roadmap: source audit, persistent chat versus pane identity, storage, native history, draft/send recovery, shutdown/updates, provider support, migration/backups and acceptance matrix. Links to the precise implemented scope; remaining hardening is not a shipped guarantee.

- `docs/account-phase-2-previews.md` - Disconnected desktop personal-account and web account/admin interfaces, local preview commands, sample interactions, 11 state/boundary tests, build evidence and verification limits. The user explicitly requires no wiring yet and web-only administration; preserve those boundaries.

- `docs/server-phase-1-implementation.md` - Bun/TypeScript backend implementation, database/auth/MFA/account/activity/monitoring and deployment tooling, 40 Linux integration tests, real HTTP restart and PostgreSQL restore evidence, native Windows test limitation, and pending live Google/email/alert acceptance.

- `docs/server-phase-1-plan.md` - Requirements for the first backend phase: isolated Bun/TypeScript server/PostgreSQL, migrations, login/session APIs, account types and administration, activity/health monitoring, Google VM checks, and end-to-end acceptance before screens; links to the local implementation record.

- `docs/login-access-plan-2026-09-12.md` - Backend-first architecture: dedicated Bun/TypeScript `apps/server`, PostgreSQL, login/session APIs, two tiers and account states, protected management, activity and monitoring, Google VM deployment, acceptance gates, and deferred screens/billing.

- `docs/mobile-bridge.md` - The opt-in, read-only LAN bridge the phone app pairs with, built for a phone on a cellular connection: what it exposes (projects, terminals-as-chats with normalized live status, a pane's ANSI-stripped screen text, a live **changed-rows frame stream** that renders the pane in a real xterm with bounded scrollback, structured `needsInput` prompt detection for one-tap chips, an agent pane's paginated saved transcript, the Orchestrator's saved history), the full API contract v1 covering both the unauthenticated discovery/pairing routes (`/api/discover`, `POST /api/pair`, the approval long-poll that delivers the code exactly once) and the bearer-authorized read routes, with rate limiting, CORS, long-poll revision semantics, gzip on every response over 512 bytes; **frame protocol v2** behind `/api/sessions/:id/stream` (gzip-encoded SSE, `hello`/`scrollback`/`screen`/`frame`/`resize`/`exit`, the self-contained ANSI row format and how a phone draws it, row hashing and diffing off the bridge's own headless decoder, twelve frames a second, the eight-stream ceiling, and the retired raw-byte ring and `since` replay), the `metrics` counters behind it, the slimmer `/api/state` and paginated `transcript`, the self-contained `/terminal/:id` page (no horizontal scroll at any width, no font floor, pinch-zoom and pan instead, hidden scrollbars with a 2 px position rail), the credential-free content-hashed `/vendor/<hash>/*` xterm assets cached immutable for a year and why they are outside both limiters, and the `?code=` query credential the stream and the page accept and what it costs; the discovery-plus-one-tap-approval pairing flow where nobody types an address or a code (desktop prompt and Settings list, three pending offers, 120 s expiry, device records, rotation signing every phone out) and the hidden manual fallback; the reserved-but-deliberately-absent write endpoints (input, interrupt, request) and the blast-radius reason they were left out of this build; security boundaries (off by default and writing nothing while off, a person approves every phone, LAN only, no TLS, 0600 preference store, the `LINA_MOBILE_BRIDGE_AUTO_APPROVE` fixture override, Windows Firewall prompt, workspace-window-only IPC); the verification commands and the measured redraw-storm numbers (66,950 PTY bytes in, 4,871 compressed out, 13.7×, 10.1 fps); and an explicit not-verified list covering real devices, touch gestures, a real TUI, scrollback while attached, real agent transcripts, off-machine access and the phone-side discovery mechanism.

- `docs/mobile-app.md` - Expo SDK 57 React Native companion client: pairing/discovery, project and terminal screens, terminal-format WebView and history, read-only bridge capability handling, notifications and background limits, Windows development/build workflow, and device/store acceptance boundaries.

- `docs/orchestrator-overhaul-2026-09-12-implementation.md` - Implementation record of the overhaul on the finished (uncommitted) tree: results against every target (1 model call per start/follow-up/named pane, interpretation 44,474 to 23,284 chars, live-tasks 4/4, suite 2,323), what each phase changed (normalizer, fallback brain, tool gating, resolver, dispatcher, prefetch, deterministic target review, ledger/pane memory/memory store with recall tools and a no-model fast path, 62-sentence conversation catalogue with progress rows and tone lint, retired reviewers, measurement script), Phase 5 (command compiler with a golden corpus, adaptive voice endpointing with early transcription and a Whisper vocabulary prompt, warm spare pane, optional interpretation model, fidelity harness), product-visible changes, and what is still open.

- `docs/orchestrator-overhaul-plan-2026-09-12.md` - Five-phase execution plan for the Orchestrator overhaul: hotfix 0.1.118 (valid tool calls, 4xx diagnostics, idle-pane reuse, transient trust screens, orphan retry, specific failures), two-call pipeline (vocabulary normalizer, slim interpretation, deterministic resolver, code-owned dispatcher, overlap), three-tier memory (action ledger, pane memory, preferences/aliases) with byte budgets replacing the raw 12-message window, reply contract, scope gating and a measurement script; targets, done-when checks and effort per phase.

- `docs/orchestrator-intent-and-repair-2026-09-12.md` - What the Orchestrator exists to do (128 saved requests classified: start, follow up, report, tidy), how well 0.1.117 serves that (58% finished, usage 48 to 1 requests/day, one request in six checking whether the prompt landed), the September 12 chain of five bugs with the reproduced HTTP 400 root cause (app-authored tool calls without `type: "function"`), the structural diagnosis, and the ranked repair packages A to E with the product decisions they need.

- `docs/codex-cursor-flicker-2026-09-11.md` - Codex-pane cursor flicker root cause: the inbox conhost ConPTY (node-pty default) splits Codex >=0.152's per-frame cursor-style repair so the parked cursor renders for a frame; bundled/newer OpenConsole keeps the frame intact; byte captures per host and Codex version, renderer replay counts, ruled-out causes, probe boundaries, and the implemented, smoke-verified repair: every Windows pane now spawns on node-pty's bundled ConPTY (`useConptyDll`), which also ends the per-exited-pane conhost leak, with `LINA_CONPTY_HOST=system` as the escape hatch and `npm run smoke:backend:conpty-host` as the lock.

- `docs/orchestrator-deserialization-plan-2026-09-11.md` - Implemented de-serialization plan (packages 1-8, September 11, 2026; only package 0, the release, is deferred) restructuring the harness after the deep dive: release current repairs, deterministic unique-title owner shortcut, structured-output reviewers, application-side observation for composer actions and composer-based startup evidence, legacy harness retirement, voice-telemetry/log, validator-reason, wake-strip and input-ceiling hygiene, and a standing call-count budget.

- `docs/orchestrator-deep-dive-2026-09-11.md` - Orchestrator capability inventory and ranked September 7–11 failure audit from the saved profile: wrong-recipient continuation (three causes incl. fenced reviewer JSON, reproduced live and repaired), unstarted prompts, generic interpretation failures, 48,000-byte input ceiling, voice-telemetry log flooding, wake-prefix leaks, naming; installed-build boundary and recommendations.

- `docs/orchestrator-continuation-errors-2026-09-11.md` - Existing-agent continuation failures: recovered schema error, unresolved agent reference, application-created wrong terminal, source repair and verification limits.

- `docs/release-0.1.117-review.md` - Orchestrator de-serialization, bundled-ConPTY panes, Codex Web Work routing, packaged Open Codex launcher and voice HUD release review, with the repairs found during review, local and CI acceptance evidence, and verified production publication.

- `docs/release-0.1.116-review.md` - Monorepo and agent integration release review, bug fixes, acceptance evidence, and production publication status.

- `docs/repository-layout.md` - Desktop/website separation, root commands, independent CI, branding, preserved history and migration evidence.

- `docs/model-providers.md` - One provider/model catalog for Open Claude Code and Open Codex; preserved legacy settings, shared default, CLI selection, protocol bridges, and verification.

- `docs/stripe-access.md` - Local Stripe credential location, verified live-mode read access, Git protection, and unverified write permissions; contains no credentials.

- `docs/open-codex.md` - Separate bundled Open Codex CLI, app-configured providers/models, Responses and Chat Completions routing, native lifecycle/history isolation, packaging and acceptance boundaries.

- `docs/fusion-menu-refresh.md` - Fusion/Open Fusion command-palette overhaul, updated model choices, current selection and draft handling, catalog refresh/pagination, Electron checks and live-runtime boundaries.

- `docs/orchestrator-agent-harness-progress.md` - Scoped agent harness: automatic project assignment, task isolation, on-demand records, acceptance evidence and verification limits.

- `docs/branding.md` - Shared Lina identity: editable vector, renderer PNG, Windows window/installer ICO, legacy compatibility, and source-versus-installed verification.

- `docs/codex-web.md` - Codex Web native TUI: external-browser login, private auth/shared global capabilities, exposed Web models and Astra preference, quota/Fast filtering, error recovery, PTY verification and live-account limits. Supersedes the removed custom chat pane.
- `docs/codex-web-model-verification.md` - Temporary Chat versus genuine Work session evidence for Astra and Sol, resource patches 43 to 45, response-model verification across HTTP SSE and WebSocket handoffs, with acceptance evidence and live-account boundaries.

- `docs/orchestrator-agent-harness-overhaul-plan.md` - Agent harness deep dive and original roadmap, with the narrowed implementation scope and deferred work stated first.

- `docs/git-branch-display.md` - Local branch/worktree display repairs: viewport placement, request isolation, live refresh, truthful Git/error states, keyboard access, bounded scans and regression checks.

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
- `docs/chat-resume-identity-fix-plan.md` - Implemented clear/new-chat resume repair: invocation-owned selection, exact ID persistence, stale-event/input fencing, native and packaged acceptance, and remaining provider boundaries.
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
