# vibeTerminal

A cut-down BridgeSpace-style workspace for local coding agents.

The app is organized as a small Electron workspace with a clear split between
frontend React code, backend Electron/PTY code, preload IPC, scripts, docs, and
external reference material.

## Tree

- `frontend/` - React UI, terminal panes, layout board, renderer types, and CSS.
- `backend/` - Electron main process, PTY host, and local agent thread discovery.
- `preload/` - Context-isolated bridge exposed as `window.vibe`.
- `scripts/` - App launch, backend smoke checks, and visual QA helpers.
- `docs/` - Navigation docs for each project section.
- `vendor/` - External reference code that is not active app source.

## Run

```powershell
npm install
npm run dev
```

## Checks

```powershell
npm run typecheck
npm run build
npm run smoke:backend:codex-discovery
npm run smoke:backend:agent-telemetry
npm run smoke:frontend:attention
```

## Visual QA

```powershell
npm run screenshot
```

The screenshot is written to `artifacts/vibe-terminal-screenshot.png`.

## Open Source

See `docs/open-source-readiness.md` for the current product-quality and
open-source readiness audit.

See `AGENTS.md` and `docs/` for the project navigation index.
