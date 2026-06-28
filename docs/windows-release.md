# Windows Release

vibeTerminal ships to Windows users as an Electron Builder NSIS installer hosted on GitHub Releases.

## Current Public Release

The current public Windows release is `v0.1.11`:

- Release page: `https://github.com/luigicarter/VibeTerminal/releases/tag/v0.1.11`
- Installer: `https://github.com/luigicarter/VibeTerminal/releases/download/v0.1.11/vibeTerminal-Setup-0.1.11.exe`
- Update metadata: `latest.yml` on the same GitHub Release.

The README download table links directly to the installer asset and to the full GitHub Releases page.

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
npm run smoke:backend:claude-discovery
npm run smoke:backend:agent-telemetry
npm run smoke:backend:code-changes
npm run smoke:backend:updates
npm run smoke:frontend:attention
npm run smoke:frontend:workspace
npm run smoke:frontend:session-launch
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

Treat the `main` branch as production. If this repository is ever referred to as
`master`, the same rule applies: any change merged or pushed there that should
reach installed users must be released, not just committed. That means the merge
must include a package version bump, matching README/docs release links, a pushed
`v<version>` tag, and a successful Windows release workflow that publishes the
installer plus `latest.yml`. Installed apps discover updates from GitHub Releases
and `latest.yml`, so pushing code to `main` alone does not update users.

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
npm run smoke:backend:claude-discovery
npm run smoke:backend:agent-telemetry
npm run smoke:backend:code-changes
npm run smoke:backend:updates
npm run smoke:frontend:attention
npm run smoke:frontend:workspace
npm run smoke:frontend:session-launch
npm run dist:win -- --publish never
```

The workflow verifies `release/latest.yml`, the installer, and the installer blockmap, then publishes them with GitHub CLI using GitHub's built-in `${{ secrets.GITHUB_TOKEN }}` through `GH_TOKEN`. Do not add a personal token to the repo, workflow file, `.env`, package config, or docs.

Manual `workflow_dispatch` runs build the installer and upload it as a workflow artifact, but they do not publish a GitHub Release.

## Update Behavior

Packaged builds check GitHub Releases once after launch. Users can also run a manual check from `Check for update` in the top bar. There is no polling.

If a newer release exists:

1. Main process reports `available` over update IPC.
2. Renderer shows a small non-blocking overlay.
3. User clicks `Update` to download.
4. User clicks `Restart` after download finishes.
5. The app calls `quitAndInstall(true, true)` so the NSIS updater runs silently and relaunches the app.

The app does not auto-download, auto-restart, or interrupt running terminal sessions. The installer UI should not appear during the restart/apply step.

Silent updates are enforced at two layers:

1. The main process passes `quitAndInstall(true, true)`, which launches the installer with the `/S` silent flag.
2. The NSIS installer itself forces silent mode whenever it is run for an update. `build/installer.nsh` defines a `customInit` hook that calls `SetSilent silent` when `${isUpdated}` is true. electron-updater always launches the installer with `--updated` for an auto-update and never for a first-time install, so a fresh install still shows the normal wizard while updates apply invisibly.

The second layer matters because the silent flag is decided by the *currently installed* build. A user updating away from a build released before the silent fix (v0.1.1 or earlier) would otherwise see the installer window once; the `customInit` hook makes the new installer silence itself regardless of how the old build launched it.

## Signing Status

The current release workflow disables certificate auto-discovery with `CSC_IDENTITY_AUTO_DISCOVERY=false`. This is suitable for early public testing, but Windows SmartScreen may warn users because the installer is not backed by a trusted publisher certificate.

Before a wider release, add code signing credentials through GitHub Actions secrets and verify the signed installer on a clean Windows machine.
