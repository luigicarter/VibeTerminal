# vibeTerminal

vibeTerminal is a Windows desktop app for running local terminals and coding agents side by side.

It gives each project its own visual workspace, so shell sessions and agent sessions stay organized instead of getting buried across separate terminal windows. Open a folder, add the terminal or agent panes you need, and arrange them on a tiled board that matches how you work.

## Download

| Platform | Download | Notes |
| --- | --- | --- |
| Windows x64 | [vibeTerminal-Setup-0.1.1.exe](https://github.com/luigicarter/VibeTerminal/releases/download/v0.1.1/vibeTerminal-Setup-0.1.1.exe) | Standard installer. Adds vibeTerminal to the Start Menu. |
| All releases | [GitHub Releases](https://github.com/luigicarter/VibeTerminal/releases) | Older versions, update metadata, and release assets. |

The installer installs vibeTerminal for the current Windows user. You do not need Node.js, npm, Vite, or TypeScript to run the installed app.

## What It Does

- Runs multiple terminal panes in one desktop window.
- Keeps sessions grouped by project folder.
- Supports local coding-agent commands such as Codex, Claude, Gemini, OpenCode, and Aider.
- Lets you resize, move, duplicate, restart, and maximize terminal panes.
- Shows attention/status indicators when agent or terminal sessions need focus.
- Includes a multi-project board for sessions that do not belong to one folder.

## Requirements

vibeTerminal includes its own Electron runtime and terminal support.

External coding-agent CLIs are separate tools. Install the providers you want to use, such as:

```text
codex
claude
gemini
opencode
aider
```

Plain PowerShell terminals work without those agent tools.

## Updates

vibeTerminal checks for updates once when it launches. You can also use `Check for update` in the top bar after launch. If a newer GitHub Release is available, the app shows a small overlay with `Update` and `Later`.

Updates are downloaded only after you accept, and the app restarts only when you choose `Restart`.

## Development

```powershell
npm install
npm run dev
```

Build a local Windows installer:

```powershell
npm run dist:win
```

See `docs/windows-release.md` for the installer layout, GitHub Releases deployment flow, updater behavior, and signing status.
