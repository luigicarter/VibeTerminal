# Preload

The `preload/` folder contains the context-isolated bridge between the renderer and Electron main process.

## Files

- `preload/preload.cjs` - Exposes `window.vibe` through `contextBridge` and forwards renderer calls to IPC channels.

## Exposed API

- `window.vibe.app.getCwd()` - Returns the app working directory.
- `window.vibe.app.getInstalledClis(options?)` - Returns the launch-time PATH scan of which agent CLIs exist on this machine, keyed by agent kind. Probed once on `app.whenReady` and cached for the session; pass `{ refresh: true }` to re-scan after the user installs something.
- `window.vibe.menu.onEvent(callback)` - Subscribes to native application-menu action broadcasts (`{ type: "action", action }`; actions: `new-terminal`, `new-claude`, `open-claude-code`, `open-settings`, `toggle-sidebar`).
- `window.vibe.claudeProviders.list()` - Lists saved Claude provider profiles (sanitized: `hasKey` flags, never key material) plus `defaultProfileId` / `hasCustomProfile`.
- `window.vibe.claudeProviders.listModels()` - Fetches every saved provider's endpoint model list (`/v1/models` per profile, cached 5 min, per-provider fail-soft).
- `window.vibe.claudeProviders.upsert(profile)` - Validates and saves a provider profile; empty `apiKey` on edit keeps the stored key.
- `window.vibe.claudeProviders.remove(id)` - Deletes a profile (clears the default if it pointed at it).
- `window.vibe.claudeProviders.setDefault(id)` - Picks the default custom provider used by "Open Claude Code" and Fusion spawns.
- `window.vibe.claudeProviders.test(payload)` - Tests a would-be or saved profile's connection (`GET {baseUrl}/v1/models`); empty `apiKey` with an `id` falls back to the stored key. Returns `{ ok, models }` or `{ ok: false, error }`.
- `window.vibe.updates.getState()` - Returns the current packaged-build update state.
- `window.vibe.updates.check()` - Manually checks for a newer packaged build.
- `window.vibe.updates.download()` - Downloads an available update after user confirmation.
- `window.vibe.updates.restart()` - Restarts and installs a downloaded update.
- `window.vibe.updates.onEvent(callback)` - Subscribes to update state changes.
- `window.vibe.workspace.selectFolder()` - Opens the native folder picker.
- `window.vibe.workspace.getCodeChanges(cwd)` - Returns a read-only Git code-change summary for a workspace folder.
- `window.vibe.agentThreads.findLatest(payload)` - Asks the backend to discover a matching local agent thread.
- `window.vibe.agentThreads.list(payload)` - Lists every saved Open Fusion chat for a folder (newest first) from the app-owned OpenCode store, for the resume picker. Open Fusion payloads only; fails closed otherwise.
- `window.vibe.terminal.create(payload)` - Creates or restores a PTY-backed session.
- `window.vibe.terminal.input(id, data)` - Sends user terminal input to the PTY host.
- `window.vibe.terminal.resize(id, cols, rows)` - Resizes the PTY session.
- `window.vibe.terminal.kill(id)` - Stops and removes a PTY session.
- `window.vibe.terminal.onEvent(callback)` - Subscribes to PTY host, terminal, snapshot, error, and exit events.
