# Preload

The `preload/` folder contains the context-isolated bridge between the renderer and Electron main process.

`window.vibe.chats` exposes workspace-only bootstrap/checkpoint, catalog
list/refresh/update, exact open, native/cached history read, draft persistence,
change notifications and shutdown-flush acknowledgment. See the
[Chats implementation](chat-section-implementation-2026-09-13.md) for recovery boundaries.

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
- `window.vibe.terminal.getRuntimeSnapshots()` / `onRuntime(callback)` - Retained standalone identity, title, process/turn/progress, and attention snapshots. Subscribe first and merge by launch generation/revision. See [terminal runtime](terminal-runtime.md).
- `window.vibe.terminal.input(id, data)` - Sends user terminal input to the PTY host.
- `window.vibe.terminal.resize(id, cols, rows)` - Resizes the PTY session.
- `window.vibe.terminal.kill(id)` - Stops and removes a PTY session.
- Terminal input, resize, and kill accept optional `{ generation, launchToken }` scope; kill also accepts the close/restart reason. Scope prevents delayed commands from affecting replacement sessions.
- `window.vibe.terminal.onEvent(callback)` - Subscribes to PTY host, terminal, snapshot, error, and exit events.
- `window.vibe.orchestrator.onActivity(callback)` - Receives redacted `{ publicationRevision, sessions, activeTargets }` patches without conversation history. Subscribe alongside `onState`; `getState()` still returns a complete snapshot. Merge by publication revision, including when activity races the initial state read. See [performance repairs](performance-orchestrator-overhaul-2026-09-10.md).
- `window.vibe.mobileBridge.getState()` / `onState(callback)` - The read-only phone bridge's status: `{ enabled, listening, host, port, addresses, code, desktopId, devices, pending, autoApprove, error }`. `addresses` are the machine's non-internal IPv4 addresses excluding `169.254.*`; `devices` are the approved phones (`{ deviceName, platform, approvedAt }`, at most 20, newest last); `pending` are the unanswered pair offers; `error` carries a listen failure such as a port already in use. Main pushes the same shape on every change.
- `window.vibe.mobileBridge.setEnabled(enabled)` - Turns the LAN listener on or off and persists the preference. Returns the new status.
- `window.vibe.mobileBridge.regenerateCode()` - Rotates the pairing code, invalidating every paired phone and clearing the device list. Returns the new status.
- `window.vibe.mobileBridge.onPairRequest(callback)` - Fires when a phone asks to pair: `{ requestId, deviceName, platform, remoteAddress, expiresAt }`. `PhonePairPrompt` (mounted at the app root) and Settings → Phone both render these; the pairing code is never handed to the network until one of them approves.
- `window.vibe.mobileBridge.respondPair(requestId, approve)` - Allows or denies one pair offer. Approving records the device and releases the phone's long poll with the code; denying records nothing. Returns `{ ok, status }`, or `{ ok: false, error }` for an unknown or already-settled offer.
- The four `mobile-bridge:*` invoke channels are refused for any sender that is not the workspace window, so no other surface can open the port or approve a phone. Nothing in this namespace carries terminal input in either direction, and nothing here reaches the live frame stream — that is HTTP only. See [mobile bridge](mobile-bridge.md).
