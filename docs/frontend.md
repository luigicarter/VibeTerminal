# Frontend

The `frontend/` folder contains the Vite React renderer that users see inside the Electron window.

## Files

- `frontend/main.tsx` - React entry point mounted by `index.html`.
- `frontend/App.tsx` - Top-level workspace UI, localStorage persistence, project selection, session lifecycle, and agent launcher controls.
- `frontend/sessionLaunch.ts` - Builds launch/resume commands for Codex, Claude, OpenCode, and plain terminal sessions.
- `frontend/types.ts` - Shared renderer-side domain types for agents, sessions, layouts, thread lookup results, and terminal events.
- `frontend/electron.d.ts` - Type declarations for the `window.vibe` preload API used by the renderer.
- `frontend/vite-env.d.ts` - Vite environment declarations.
- `frontend/styles.css` - App shell, sidebar, toolbar, terminal pane, status, and tiled-board styling.

## Components

- `frontend/components/TerminalPane.tsx` - Owns the xterm instance for a session, sends terminal input/resize IPC calls, receives PTY events, and polls for agent thread metadata.
- `frontend/components/TiledBoard.tsx` - Drag/resize layout engine for terminal panes, including collision handling, swaps, adjacent resize behavior, and persisted fluid layouts.

## Entry Points

- `index.html` loads `/frontend/main.tsx`.
- `tsconfig.json` includes `frontend/` for strict renderer typechecking.
- `npm run dev:frontend` starts the Vite renderer on `127.0.0.1:5173`.
