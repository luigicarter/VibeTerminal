# Open Source Readiness

This audit is based on the current app source, docs, and verification scripts.
vibeTerminal is already strong enough to show publicly as a local-first agent
workspace, but it should get a small hardening pass before the first public repo
push.

## Current Strengths

- The product shape is clear: a tiled local workspace for terminal and coding
  agent panes, with both project-scoped boards and free multi-folder mode.
- The renderer is more than a mockup. It has persisted workspaces, persisted
  layouts, pane duplicate/restart/maximize controls, xterm integration, and
  agent launch buttons.
- The process boundary is sensible. Electron main owns child hosts, terminal
  sessions run in a PTY host, and agent thread discovery runs in a separate host
  so filesystem and CLI scans do not block the UI.
- The preload API is narrow and context-isolated. The renderer talks through
  explicit app, workspace, agentThreads, and terminal methods instead of using
  direct Node access.
- The docs already explain the frontend, backend, preload, scripts, vendor, and
  runtime-artifact boundaries. That makes the project much easier for outside
  contributors to enter.
- The local verification surface is real: typecheck, production build, Codex
  discovery smoke, agent telemetry smoke, attention helper smoke, and screenshot
  QA all exist and were run successfully.

## What Makes It Different

- It is an agent supervision surface, not just another terminal skin. Multiple
  agents can be visible at once, restarted, duplicated, resized, maximized, and
  associated with local thread metadata.
- The app stays local-first. It launches real user-installed CLIs in real working
  directories and does not need a hosted backend for the core workflow.
- The board model is immediately understandable: open a folder, add terminal or
  agent panes, and keep all activity visible in one workspace.
- The provider idea is already present. Codex, Claude, OpenCode, Gemini, Aider,
  and plain terminals are represented in the UI, with deeper thread lookup for
  threaded providers.

## Publish Blockers

- This folder is not currently a Git repository. Initialize a clean repo before
  publishing so ignored generated files are enforced from the first commit.
- `package.json` has `"private": true` and no license, repository, bugs,
  homepage, author, or keywords metadata.
- There is no root `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, or code of
  conduct. At minimum, add a license and security policy before inviting users.
- `vendor/codex-official/` is local reference material, not active app source.
  Decide whether to remove it, keep it out of Git, or document its licensing and
  update policy very explicitly.
- Public screenshots must be curated. `artifacts/` is ignored, but screenshots
  can contain local project paths and terminal output.
- The Windows packaged release path now exists in `docs/windows-release.md`.
  Code signing is still the main release-trust gap before a wider public launch.

## Hardening Before Announcement

- Add a first-run trust note in the README: vibeTerminal launches real local
  shells and writes provider commands into those shells.
- Add provider availability checks before launching a pane. If `codex`,
  `claude`, `opencode`, `gemini`, or `aider` is missing from `PATH`, show a
  clear inline error instead of opening a shell that immediately fails.
- Validate IPC payloads in the main process. The preload bridge is narrow, but
  `terminal:create`, `terminal:input`, `terminal:resize`, `terminal:kill`, and
  `agent-thread:latest` should still reject malformed payloads.
- Decide the external-link policy. The xterm web-links addon is useful, but the
  Electron window should explicitly handle new-window and external-link behavior.
- Consider a stricter Electron security checklist: content security policy,
  `setWindowOpenHandler`, no remote content, and a deliberate decision on
  BrowserWindow sandboxing after testing preload compatibility.
- Add a PTY lifecycle smoke test that creates a session, writes a command,
  receives output, resizes, kills, and confirms cleanup.
- Add a renderer interaction smoke test for add pane, resize/move, restart,
  maximize, and persistence restore.

## Open Source Roadmap

1. Repository hygiene: initialize Git, keep generated folders ignored, remove or
   exclude vendor reference material, and commit only source, docs, scripts, and
   lockfiles.
2. Project identity: add license, package metadata, README screenshots, feature
   list, prerequisites, supported platforms, and a concise threat model.
3. Contributor path: add setup instructions, development commands, verification
   commands, contribution rules, and issue templates.
4. Runtime robustness: provider detection, IPC validation, PTY smoke tests, and
   clearer user-facing errors.
5. Release path: use the Windows installer and GitHub Releases flow in
   `docs/windows-release.md`; add trusted code signing before wider distribution.
6. Extensibility: turn agent providers into a small adapter layer so contributors
   can add provider commands and thread discovery without touching core UI code.

## Verified In This Pass

- `npm run typecheck`
- `npm run smoke:backend:codex-discovery`
- `npm run smoke:backend:agent-telemetry`
- `npm run smoke:frontend:attention`
- `npm run build`
- `npm run screenshot`

The refreshed screenshot was written to
`artifacts/vibe-terminal-screenshot.png`.
