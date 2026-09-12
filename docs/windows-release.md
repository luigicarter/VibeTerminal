# Windows Release

Lina Terminal ships to Windows users as an Electron Builder NSIS installer hosted on GitHub Releases.

## Current Public Release

The current Windows release is `v0.1.117`:

- Release page: `https://github.com/luigicarter/VibeTerminal/releases/tag/v0.1.117`
- Installer: `https://github.com/luigicarter/VibeTerminal/releases/download/v0.1.117/LinaTerminal-Setup-0.1.117.exe`
- Update metadata: `latest.yml` on the same GitHub Release.

The README download table links directly to the installer asset and to the full GitHub Releases page.

Starting with v0.1.104, releases are branded **Lina Terminal**, produce
`LinaTerminal-Setup-<version>.exe`, and use **Hey Lina**. Older release assets
retain their original vibeTerminal names.

## User Install Path

The installer is per-user by default and does not require admin elevation.

- New app install: `%LOCALAPPDATA%\Programs\LinaTerminal` (updates can retain the previous install directory)
- App executable: `LinaTerminal.exe` in the install directory
- Electron user data: `%APPDATA%\vibe-terminal`
- Agent shim runtime data: `%APPDATA%\vibe-terminal\agent-shims`
- Open Fusion generated OpenCode config, commands, TUI plugin, and pane model state: `%APPDATA%\vibe-terminal\openfusion`

The package name (`vibe-terminal`), app ID (`com.vibeterminal.app`), storage keys,
and GitHub update repository retain their existing identities for compatibility.
The main process preserves Electron's existing user-data path before setting its
display name. The Start Menu/desktop shortcuts and uninstall entry show **Lina Terminal**.

The uninstall entry appears in Windows Settings under installed apps. Uninstall removes the app files and shortcuts, but user data is intentionally left in `%APPDATA%\vibe-terminal`.

## Installed Contents

The packaged app keeps only runtime files needed by Electron:

- `backend/` - Electron main process, PTY host, telemetry shims, and agent thread discovery helpers.
- `preload/` - Context bridge IPC surface.
- `shared/` - Provider capability contracts.
- `resources/voice/alerts/` - Offline spoken alert clips, checksum-verified as they load.
- `resources/voice/models/` - Pinned keyword, VAD, and turn-completion models and notices.
- `dist/` - Compiled renderer UI produced by Vite.
- `frontend/assets/` - Runtime app icons and logo assets.
- `resources/codex-bin/win32-x64/` - Embedded private Codex CLI payload used
  only by Fusion panes: `codex.exe`, its code-mode host, package metadata,
  bundled ripgrep, command runner, and Windows sandbox setup helper.
- production `node_modules/` dependencies.
- unpacked `node-pty`, sherpa-onnx, and ONNX Runtime files. Voice helpers load the
  two inference runtimes in separate processes.

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

Version `0.1.117` de-serializes the Orchestrator, spawns every Windows pane on
node-pty's bundled ConPTY, and opens genuine Work sessions for Codex Web Work
models with response-model verification. It repairs the packaged Open Codex
launcher, redesigns the voice indicator with a Stop control for the current
voice turn, and removes the in-app version switcher.
See [the release review](release-0.1.117-review.md) for verification and
remaining boundaries.
Installed applications apply updates through the user's Update/Restart action;
publication does not restart an active workspace.

Use these commands before publishing a release:

```powershell
cd apps/desktop
npm ci
node node_modules/electron/install.js
$codexVersion = (Get-ChildItem vendor/codex-appserver -Directory | Where-Object Name -match '^\d+\.\d+\.\d+$').Name
npm install --prefix .tmp/codex-release-cli --no-save "@openai/codex@$codexVersion"
$env:VIBE_CODEX_BIN_SEARCH_ROOTS = (Resolve-Path .tmp/codex-release-cli/node_modules/@openai).Path
npm run prepare:codex-bin:required
npm run prepare:open-codex
npm run prepare:codex-web
npm run prepare:voice
npm run typecheck
npm run smoke:backend:codex-discovery
npm run smoke:backend:claude-discovery
npm run smoke:backend:agent-telemetry
npm run smoke:backend:code-changes
npm run smoke:backend:updates
npm run smoke:backend:fusion-launch
npm run smoke:backend:fusion-adapter
npm run smoke:backend:fusion-chat-parse
npm run smoke:backend:completion-gate
npm run smoke:backend:openfusion-chat-parse
npm run smoke:backend:openfusion-background-status
npm run smoke:backend:openfusion-custom-provider
npm run smoke:backend:fusion-appserver:embedded
npm run smoke:frontend:attention
npm run smoke:frontend:workspace
npm run smoke:frontend:session-launch
npm run smoke:frontend:fusion-settings
npm run smoke:frontend:tiled-resize
npm run dist:win -- --publish never
```

Run desktop release commands from `apps/desktop`; artifacts are written to its
`release/` directory. Root `npm run dist:win` forwards to this app directory.

- `release/LinaTerminal-Setup-<version>.exe`
- `release/LinaTerminal-Setup-<version>.exe.blockmap`
- `release/latest.yml`
- `release/win-unpacked/`

`npmRebuild` is disabled in the Electron Builder config because `node-pty` supplies Windows prebuilds that load correctly from the unpacked ASAR path. This avoids requiring Visual Studio native build components on release machines.

## Runtime Verification

After `npm run dist:win -- --publish never`, verify:

1. `release/LinaTerminal-Setup-<version>.exe` exists.
2. `release/latest.yml` points at the installer for the same version.
3. `release/win-unpacked/LinaTerminal.exe` launches.
4. The complete embedded Codex payload exists under
   `release/win-unpacked/resources/codex-bin/win32-x64/`: `codex.exe`,
   `codex-code-mode-host.exe`, `codex-package.json`, `codex-path/rg.exe`, and
   both executables under `codex-resources/`.
5. A packaged PTY can start PowerShell and run a command.
6. A packaged Fusion pane does not fall back to the user's global `codex` if the
   embedded binary is removed; it should fail start with a clear Fusion error.
7. The packaged UI loads from `dist/index.html`, not a Vite dev server.
8. Run `node scripts/qa/verify-release-artifacts.cjs` to verify version, filename,
   installer size/SHA-512, blockmap, and packaged voice alert clips.

## GitHub Release Deployment

Production downloads and update metadata live in the public GitHub repository:

`https://github.com/luigicarter/VibeTerminal/releases`

The GitHub Actions workflow `.github/workflows/windows-release.yml` builds on `windows-latest`.
It initializes the pinned Codex reference submodule used by the native fixtures,
prepares the separate Open Codex and Codex Web payloads before acceptance, and
validates their packaged executables, helpers, and Web runtime checksums.
It builds the renderer before release checks and explicitly installs and verifies
the pinned Electron executable for UI tests;
the Electron npm package does not provide an automatic install lifecycle script.
It verifies the bundled voice alert clips and models, runs `scripts/qa/release-checks.cjs`
with fail-fast handling, and verifies installer/feed hashes, packaged voice checksums,
and native inference dependencies using `scripts/qa/verify-release-artifacts.cjs`.
`scripts/qa/voice-packaged-smoke.cjs` then starts both inference helpers with the
shipped Electron executable before publication. Real Electron voice capture and
history/context checks also gate publication. Tag releases and manual artifact
builds share the same build and verification steps. `vendor/voice` is committed with
byte-preserving Git attributes because its runtime assets are checksummed on load.

Treat the `main` branch as production. If this repository is ever referred to as
`master`, the same rule applies: any change merged or pushed there that should
reach installed users must be released, not just committed. That means the merge
must include a package version bump, matching README/docs release links, a pushed
`v<version>` tag, and a successful Windows release workflow that publishes the
installer plus `latest.yml`. Installed apps discover updates from GitHub Releases
and `latest.yml`, so pushing code to `main` alone does not update users.

To publish, create the version metadata without npm's automatic commit/tag so
the package version and public download links can be committed together:

```powershell
npm version patch --no-git-tag-version
$version = node -p "require('./package.json').version"
# Update README.md and this file's current-release links to v$version.
git add -A
git commit -m "Release v$version"
git tag "v$version"
git push origin main
git push origin "v$version"
```

Before committing, verify `git status --short` includes the new vendored Codex
app-server version and removal of the old one; the new version directory is
untracked during an upgrade and is easy to omit with a path-specific `git add`.

When a `v*` tag is pushed, the workflow runs:

```powershell
npm ci
$codexVersion = (Get-ChildItem vendor/codex-appserver -Directory | Where-Object Name -match '^\d+\.\d+\.\d+$').Name
npm install -g "@openai/codex@$codexVersion"
npm run prepare:codex-bin:required
npm run typecheck
npm run smoke:backend:codex-discovery
npm run smoke:backend:claude-discovery
npm run smoke:backend:agent-telemetry
npm run smoke:backend:code-changes
npm run smoke:backend:updates
npm run smoke:backend:fusion-launch
npm run smoke:backend:fusion-adapter
npm run smoke:backend:fusion-chat-parse
npm run smoke:backend:completion-gate
npm run smoke:backend:openfusion-chat-parse
npm run smoke:backend:openfusion-background-status
npm run smoke:backend:openfusion-custom-provider
npm run smoke:backend:fusion-appserver:embedded
npm run smoke:frontend:attention
npm run smoke:frontend:workspace
npm run smoke:frontend:session-launch
npm run smoke:frontend:fusion-settings
npm run smoke:frontend:tiled-resize
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

## Version selection

The in-app version switcher has been removed. `Check for update` still checks
for the latest release, with the existing download and explicit restart flow.
The release-list and selected-version installer handlers are no longer exposed
through the preload bridge or registered in the main process.

This takes effect in builds containing the removal. Existing installations keep
their previous behavior until updated. Older installers can still be installed
manually if available; this change does not delete published release assets.

## Signing Status

The current release workflow disables certificate auto-discovery with `CSC_IDENTITY_AUTO_DISCOVERY=false`. This is suitable for early public testing, but Windows SmartScreen may warn users because the installer is not backed by a trusted publisher certificate.

Before a wider release, add code signing credentials through GitHub Actions secrets and verify the signed installer on a clean Windows machine.
