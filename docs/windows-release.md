# Windows Release

vibeTerminal ships to Windows users as an Electron Builder NSIS installer hosted on GitHub Releases.

## User Install Path

The installer is per-user by default and does not require admin elevation.

- App install: `%LOCALAPPDATA%\Programs\vibeTerminal`
- App executable: `%LOCALAPPDATA%\Programs\vibeTerminal\vibeTerminal.exe`
- Electron user data: `%APPDATA%\vibeTerminal`
- Agent shim runtime data: `%APPDATA%\vibeTerminal\agent-shims`

The uninstall entry appears in Windows Settings under installed apps. Uninstall removes the app files and shortcuts, but user data is intentionally left in `%APPDATA%\vibeTerminal`.

## Installed Contents

The packaged app keeps only runtime files needed by Electron:

- `backend/` - Electron main process, PTY host, telemetry shims, and agent thread discovery helpers.
- `preload/` - Context bridge IPC surface.
- `dist/` - Compiled renderer UI produced by Vite.
- `frontend/assets/` - Runtime app icons and logo assets.
- production `node_modules/` dependencies.
- unpacked `node-pty` native files.

The package excludes development and reference material:

- `vendor/`
- `docs/`
- `scripts/`
- `.tmp/`
- `artifacts/`
- Vite and TypeScript dev tooling
- Electron Builder dev tooling
- renderer source files such as `frontend/App.tsx`

The compiled `dist/` renderer is still included because it is the UI Electron displays in production.

## Local Build

Use these commands before publishing a release:

```powershell
npm ci
npm run typecheck
npm run smoke:backend:codex-discovery
npm run smoke:backend:agent-telemetry
npm run smoke:frontend:attention
npm run dist:win -- --publish never
```

The installer artifacts are written to `release/`:

- `release/vibeTerminal-Setup-<version>.exe`
- `release/vibeTerminal-Setup-<version>.exe.blockmap`
- `release/latest.yml`
- `release/win-unpacked/`

`npmRebuild` is disabled in the Electron Builder config because `node-pty` supplies Windows prebuilds that load correctly from the unpacked ASAR path. This avoids requiring Visual Studio native build components on release machines.

## Runtime Verification

After `npm run dist:win -- --publish never`, verify:

1. `release/vibeTerminal-Setup-<version>.exe` exists.
2. `release/latest.yml` points at the installer for the same version.
3. `release/win-unpacked/vibeTerminal.exe` launches.
4. A packaged PTY can start PowerShell and run a command.
5. The packaged UI loads from `dist/index.html`, not a Vite dev server.

## GitHub Release Deployment

Production downloads and update metadata live in the public GitHub repository:

`https://github.com/luigicarter/VibeTerminal/releases`

The GitHub Actions workflow `.github/workflows/windows-release.yml` builds on `windows-latest`.

To publish:

```powershell
npm version patch
git push
git push origin v<version>
```

When a `v*` tag is pushed, the workflow runs:

```powershell
npm ci
npm run typecheck
npm run smoke:backend:codex-discovery
npm run smoke:backend:agent-telemetry
npm run smoke:frontend:attention
npm run dist:win -- --publish always
```

The workflow uses GitHub's built-in `${{ secrets.GITHUB_TOKEN }}` through `GH_TOKEN`. Do not add a personal token to the repo, workflow file, `.env`, package config, or docs.

Manual `workflow_dispatch` runs build the installer and upload it as a workflow artifact, but they do not publish a GitHub Release.

## Update Behavior

Packaged builds check GitHub Releases once after launch. There is no polling.

If a newer release exists:

1. Main process reports `available` over update IPC.
2. Renderer shows a small non-blocking overlay.
3. User clicks `Update` to download.
4. User clicks `Restart` after download finishes.
5. The app calls `quitAndInstall`.

The app does not auto-download, auto-restart, or interrupt running terminal sessions.

## Signing Status

The current release workflow disables certificate auto-discovery with `CSC_IDENTITY_AUTO_DISCOVERY=false`. This is suitable for early public testing, but Windows SmartScreen may warn users because the installer is not backed by a trusted publisher certificate.

Before a wider release, add code signing credentials through GitHub Actions secrets and verify the signed installer on a clean Windows machine.
