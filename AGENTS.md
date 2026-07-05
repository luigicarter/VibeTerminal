# vibeTerminal Agent Guide

vibeTerminal is an Electron + React desktop workspace for running local terminals and coding agents side by side.

## Docs Index

- `docs/frontend.md` - React renderer files, UI state, terminal panes, layout board, and styling.
- `docs/backend.md` - Electron main process, PTY host, and agent thread discovery files.
- `docs/preload.md` - Context bridge and IPC surface exposed to the renderer.
- `docs/scripts.md` - Development, smoke test, and screenshot helper scripts.
- `docs/windows-release.md` - Windows installer, GitHub Releases deployment, update behavior, and signing status.
- `docs/fusion-terminal.md` - Shipped two-model Fusion architecture (Opus orchestrator + embedded per-pane Codex executor, the adapter, approval/verifier loop).
- `docs/openfusion.md` - Open Fusion chat mode: vibeTerminal-native chat pane over a headless per-pane `opencode serve` (no OpenCode TUI), full data ownership (threads, credentials, and config in an app-owned OpenCode home under userData via XDG overrides — the user's global OpenCode install is never read or written), pane-scoped OpenCode config, no default models (first-run gate: connect a provider, then pick Brain/Executor), model pickers and slash commands, in-pane permission approvals, OpenCode-parity provider auth (method select, prompt fields, API key + metadata, browser OAuth, unknown provider ids refused), hard read-only investigator subagent, and planner-owned review gate.
- `docs/fusion-and-open-fusion.md` - Product description of Fusion and Open Fusion in one file: what each feature is (Claude+Codex vs any two chosen models), who each is best for, an at-a-glance comparison, and what they share; points to `docs/fusion-terminal.md` and `docs/openfusion.md` for the technical deep-dives.
- `docs/fusion-unification.md` - Analysis + verified design path for making Fusion read/behave as one unified agent (perceptual vs cognitive unity, seams, guarantee-preserving levers).
- `docs/fusion-unification-handoff.md` - Pick-up note for the unification work: status, the exact first change, gotchas, and how to verify.
- `docs/voice-dictation.md` - Proposed speech-to-text design sketch (not implemented): provider-agnostic mic→text→inject feature, engine options, open questions.
- `docs/vendor.md` - External reference material kept outside active app source.
- `docs/runtime-artifacts.md` - Generated folders, outputs, and cleanup expectations.
