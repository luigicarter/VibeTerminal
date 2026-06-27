# Preload

The `preload/` folder contains the context-isolated bridge between the renderer and Electron main process.

## Files

- `preload/preload.cjs` - Exposes `window.vibe` through `contextBridge` and forwards renderer calls to IPC channels.

## Exposed API

- `window.vibe.app.getCwd()` - Returns the app working directory.
- `window.vibe.workspace.selectFolder()` - Opens the native folder picker.
- `window.vibe.agentThreads.findLatest(payload)` - Asks the backend to discover a matching local agent thread.
- `window.vibe.terminal.create(payload)` - Creates or restores a PTY-backed session.
- `window.vibe.terminal.input(id, data)` - Sends user terminal input to the PTY host.
- `window.vibe.terminal.resize(id, cols, rows)` - Resizes the PTY session.
- `window.vibe.terminal.kill(id)` - Stops and removes a PTY session.
- `window.vibe.terminal.onEvent(callback)` - Subscribes to PTY host, terminal, snapshot, error, and exit events.
